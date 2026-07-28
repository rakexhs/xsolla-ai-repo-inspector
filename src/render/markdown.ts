/**
 * Markdown rendering of a `ReviewResult`.
 *
 * The report is written for two readers at once: a human skimming a CI log and
 * a language model that will act on it. Both are served by the same discipline
 * — the outcome is decidable from the `## Summary` section alone, and nothing
 * below it can change what that section said.
 *
 * The hard problem here is that a validation's captured output is **untrusted
 * text** that ends up inside a structured document. A test runner that prints
 * a Markdown fence, or a linter whose rule name happens to be `## Diagnostics`,
 * must not be able to close a code block early or forge a report section. Every
 * captured byte therefore goes through `fenceFor`, which returns a fence wider
 * than the longest backtick run inside the content, and inline text (paths in
 * table cells) is escaped for both backticks and pipes.
 *
 * Rendering is deterministic: identical input produces byte-identical output.
 * Paths are ordered with `comparePaths` (a UTF-8 byte comparison) rather than
 * `localeCompare`, which is locale-dependent and would make the CLI/MCP
 * consistency test flaky across machines.
 */

import type { ChangedFile, DetailLevel, ReviewResult, Scope, ValidationOutcome } from "../core/types.js";
import { SCOPES } from "../core/types.js";
import { clampText, comparePaths, fenceFor, sanitizeOutput } from "../core/text.js";

/**
 * The diagnostic shape as `ReviewResultSchema` infers it. `errors.ts` exports a
 * hand-written `Diagnostic` whose `hint?: string` is not assignable from zod's
 * `hint?: string | undefined` under `exactOptionalPropertyTypes`, so the
 * renderer derives its type from the result it is given.
 */
type ResultDiagnostic = ReviewResult["diagnostics"][number];
type DiagnosticSeverity = ResultDiagnostic["severity"];

// ---------------------------------------------------------------------------
// Compact-mode budgets
// ---------------------------------------------------------------------------

/** `detail: "summary"` — paths listed per scope before eliding. */
const SUMMARY_MAX_FILES_PER_SCOPE = 20;
/** `detail: "summary"` — trailing lines of a *failing* validation's output. */
const SUMMARY_MAX_OUTPUT_LINES = 20;

const SEVERITY_ORDER: readonly DiagnosticSeverity[] = ["fatal", "error", "warning"];

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  fatal: "Fatal",
  error: "Errors",
  warning: "Warnings",
};

export type RenderMarkdownOptions = {
  /**
   * Whole-document byte budget. Unlimited by default so the CLI, which writes
   * to a file or a terminal, is unaffected; the MCP adapter passes
   * `limits.maxTotalBytes` because its output lands in a context window.
   */
  maxBytes?: number;
};

// ---------------------------------------------------------------------------
// Inline escaping
// ---------------------------------------------------------------------------

/** Collapses any text to a single line so it cannot break a list item or row. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** Longest run of consecutive backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    if (char === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Wraps text in an inline code span whose delimiter is wider than any backtick
 * run inside it, padding with spaces when the content itself starts or ends
 * with a backtick (CommonMark strips exactly one such pad).
 */
function codeSpan(text: string): string {
  const flat = oneLine(text);
  if (flat === "") return "`(empty)`";
  const ticks = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/**
 * Escapes a rendered cell for a GFM table.
 *
 * `|` is the one character GFM resolves *before* inline parsing, so it must be
 * backslash-escaped even inside a code span — otherwise a path such as
 * `src/a|b.ts` silently splits the row into an extra column.
 */
function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** A path rendered for a table cell: code-spanned, then pipe-escaped. */
function pathCell(path: string): string {
  return tableCell(codeSpan(path));
}

// ---------------------------------------------------------------------------
// Fenced blocks
// ---------------------------------------------------------------------------

/**
 * Fences captured output so it cannot escape its block.
 *
 * This is the containment boundary for untrusted subprocess output: `fenceFor`
 * guarantees the delimiter is wider than the longest backtick run inside, so no
 * interior line can terminate the block, and everything within — including a
 * line reading `## Diagnostics` — is inert literal text.
 */
function fencedBlock(content: string, info = ""): string {
  const fence = fenceFor(content);
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return `${fence}${info}\n${body}\n${fence}`;
}

/** POSIX-ish quoting so a fenced argv line is unambiguous and copy-pastable. */
function quoteArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function formatArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

// ---------------------------------------------------------------------------
// Small derivations
// ---------------------------------------------------------------------------

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function isFailing(validation: ValidationOutcome): boolean {
  return validation.status !== "passed";
}

function failingValidations(result: ReviewResult): ValidationOutcome[] {
  return result.validations.filter(isFailing);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Why the review did not pass, in one line. Fatal diagnostics outrank failing
 * validations because they mean the review itself is incomplete.
 */
function failureReason(result: ReviewResult): string | null {
  const fatal = result.diagnostics.find((d) => d.severity === "fatal");
  if (fatal) return `${fatal.code}: ${oneLine(fatal.message)}`;

  const failing = failingValidations(result);
  if (failing.length > 0) {
    const names = failing.map((v) => oneLine(v.id)).join(", ");
    return `${failing.length} ${plural(failing.length, "validation")} did not pass (${names})`;
  }

  const error = result.diagnostics.find((d) => d.severity === "error");
  if (error) return `${error.code}: ${oneLine(error.message)}`;

  return null;
}

/** Human description of HEAD, covering unborn and detached states. */
function describeHead(result: ReviewResult): string {
  const head = result.repository.head;
  if (head.unborn) return "no commits yet";
  if (head.detached) {
    return head.sha === null ? "detached @ unknown" : `detached @ ${shortSha(head.sha)}`;
  }
  const branch = head.branch === null ? "(unknown branch)" : head.branch;
  const at = head.sha === null ? "" : ` @ ${shortSha(head.sha)}`;
  return `${branch}${at}`;
}

/** Best available explanation for a missing base, drawn from the diagnostics. */
function missingBaseReason(result: ReviewResult): string {
  const relevant = result.diagnostics.find(
    (d) =>
      d.code === "W_NO_BASE_REF" ||
      d.code === "W_NO_COMMITS" ||
      d.code === "E_BASE_REF_UNKNOWN" ||
      d.code === "E_NO_MERGE_BASE",
  );
  return relevant ? oneLine(relevant.message) : "no base ref resolved";
}

function describeBase(result: ReviewResult): string {
  const base = result.repository.base;
  if (base === null) return `none — ${missingBaseReason(result)}`;
  const requested =
    base.requested === null
      ? base.autoDetected
        ? " (auto-detected)"
        : ""
      : base.requested === base.ref
        ? ""
        : ` (requested ${base.requested})`;
  return `${base.ref} @ ${shortSha(base.sha)}, merge-base ${shortSha(base.mergeBase)}${requested}`;
}

/** Requested scopes in canonical `SCOPES` order, so output never depends on argv order. */
function orderedScopes(result: ReviewResult): Scope[] {
  const requested = new Set<Scope>(result.scopes);
  return SCOPES.filter((scope) => requested.has(scope));
}

/** Byte-ordered copy; the renderer never trusts upstream ordering. */
function sortedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => {
    const byPath = comparePaths(a.path, b.path);
    if (byPath !== 0) return byPath;
    return comparePaths(a.status, b.status);
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderProvenance(result: ReviewResult): string[] {
  const scopes = orderedScopes(result);
  return [
    "# Repository review",
    "",
    `- Repository: ${codeSpan(result.repository.path)}`,
    `- HEAD: ${codeSpan(describeHead(result))}`,
    `- Base: ${codeSpan(describeBase(result))}`,
    `- Scopes inspected: ${scopes.length === 0 ? "_none_" : scopes.map(codeSpan).join(", ")}`,
    `- Detail: ${codeSpan(result.detail)}`,
    "",
  ];
}

function renderSummary(result: ReviewResult): string[] {
  const lines: string[] = ["## Summary", ""];

  const reason = failureReason(result);
  if (result.ok) {
    lines.push("**PASSED** — no fatal diagnostics and every executed validation passed.");
  } else {
    lines.push(`**FAILED** — ${reason ?? "the review reported a non-ok result"}.`);
  }
  lines.push("");

  // Per-scope counts. All four scopes are always listed so the reader can see
  // what was *not* inspected, which is otherwise invisible.
  const requested = new Set<Scope>(result.scopes);
  const counts = result.changes.counts;
  lines.push("| Scope | Files |", "| --- | --- |");
  for (const scope of SCOPES) {
    const value = requested.has(scope) ? String(counts[scope]) : "_not inspected_";
    lines.push(`| ${scope} | ${value} |`);
  }
  lines.push(`| **distinct files** | **${counts.distinctFiles}** |`, "");

  if (result.changes.listTruncated) {
    lines.push("_Some file lists were truncated by a per-scope cap; see each scope below._", "");
  }

  // Validation tallies.
  const total = result.validations.length;
  if (total === 0) {
    lines.push("Validations: none run.", "");
  } else {
    const passed = result.validations.filter((v) => !isFailing(v)).length;
    const failing = failingValidations(result);
    const byStatus = new Map<string, number>();
    for (const validation of failing) {
      byStatus.set(validation.status, (byStatus.get(validation.status) ?? 0) + 1);
    }
    // The breakdown only earns its space when the failures are of mixed kinds;
    // "1 not passed (1 failed)" is noise.
    const breakdown =
      byStatus.size > 1
        ? [...byStatus.entries()]
            .sort((a, b) => comparePaths(a[0], b[0]))
            .map(([status, n]) => `${n} ${status}`)
            .join(", ")
        : "";
    lines.push(
      `Validations: ${passed} passed, ${failing.length} not passed${breakdown ? ` (${breakdown})` : ""}.`,
      "",
    );
    if (failing.length > 0) {
      lines.push(`Failing: ${failing.map((v) => codeSpan(v.id)).join(", ")}.`, "");
    }
  }

  return lines;
}

function changeNote(file: ChangedFile): string {
  const parts: string[] = [];
  if (file.kind === "directory") {
    parts.push("opaque directory marker; contents not inspected");
  }
  if (file.status === "renamed" && file.origPath !== undefined) {
    parts.push(`renamed from ${codeSpan(file.origPath)}`);
  } else if (file.status === "copied" && file.origPath !== undefined) {
    parts.push(`copied from ${codeSpan(file.origPath)}`);
  } else if (file.origPath !== undefined) {
    parts.push(`from ${codeSpan(file.origPath)}`);
  }
  if (file.score !== undefined) parts.push(`similarity ${file.score}%`);
  return parts.join(", ");
}

function renderScope(result: ReviewResult, scope: Scope): string[] {
  const all = sortedFiles(result.changes[scope]);
  const reported = result.changes.counts[scope];
  const lines: string[] = [`### ${scope}`, ""];

  if (all.length === 0) {
    lines.push("_No changes._", "");
    return lines;
  }

  // Two independent elisions can apply: the upstream per-scope cap that already
  // shortened the array, and the compact cap this renderer adds for `summary`.
  const upstreamElided = Math.max(0, reported - all.length);
  const cap = result.detail === "summary" ? SUMMARY_MAX_FILES_PER_SCOPE : all.length;
  const shown = all.slice(0, cap);
  const renderElided = all.length - shown.length;

  lines.push("| Path | Status | Notes |", "| --- | --- | --- |");
  for (const file of shown) {
    lines.push(`| ${pathCell(file.path)} | ${file.status} | ${tableCell(changeNote(file))} |`);
  }
  lines.push("");

  if (upstreamElided > 0) {
    lines.push(
      `_${upstreamElided} further ${plural(upstreamElided, "path")} in this scope ${plural(upstreamElided, "was", "were")} elided by the per-scope path cap (${reported} total)._`,
      "",
    );
  }
  if (renderElided > 0) {
    lines.push(
      `_${renderElided} more ${plural(renderElided, "path")} not shown at detail \`summary\`._`,
      "",
    );
  }

  return lines;
}

function renderChanges(result: ReviewResult): string[] {
  const lines: string[] = ["## Changes", ""];
  const scopes = orderedScopes(result);
  if (scopes.length === 0) {
    lines.push("_No scopes were inspected._", "");
    return lines;
  }
  for (const scope of scopes) lines.push(...renderScope(result, scope));
  return lines;
}

/** Trailing `n` lines of `text`, with a count of what was dropped. */
function tailLines(text: string, n: number): { text: string; dropped: number } {
  const lines = text.split("\n");
  if (lines.length <= n) return { text, dropped: 0 };
  return { text: lines.slice(lines.length - n).join("\n"), dropped: lines.length - n };
}

function renderStream(
  label: string,
  raw: string,
  truncatedUpstream: boolean,
  detail: DetailLevel,
): string[] {
  // Defensive and idempotent: the capture layer sanitises, but the renderer is
  // the last gate before bytes reach a terminal or a context window.
  const content = sanitizeOutput(raw);
  if (content.trim() === "") return []; // Skip empty streams rather than emit an empty fence.

  let body = content;
  let renderDropped = 0;
  if (detail === "summary") {
    const tail = tailLines(content, SUMMARY_MAX_OUTPUT_LINES);
    body = tail.text;
    renderDropped = tail.dropped;
  }

  const notes: string[] = [];
  if (truncatedUpstream) notes.push("truncated by output limits");
  if (renderDropped > 0) notes.push(`first ${renderDropped} ${plural(renderDropped, "line")} omitted`);
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";

  return [`${label}${suffix}:`, "", fencedBlock(body), ""];
}

function renderValidation(validation: ValidationOutcome, detail: DetailLevel): string[] {
  const lines: string[] = [`### ${codeSpan(validation.id)} — ${validation.status}`, ""];

  lines.push("Command:", "", fencedBlock(formatArgv(validation.argv)), "");

  const facts: string[] = [
    `Status: ${validation.status}`,
    `Exit code: ${validation.exitCode === null ? "n/a" : String(validation.exitCode)}`,
    `Duration: ${validation.durationMs} ms`,
  ];
  if (validation.signal !== null) facts.push(`Signal: ${validation.signal}`);
  if (validation.reason !== undefined) facts.push(`Reason: ${oneLine(validation.reason)}`);
  for (const fact of facts) lines.push(`- ${fact}`);
  lines.push("");

  // At detail `summary` a passing validation's output is pure noise: the
  // status line already carries everything the reader needs.
  const showOutput = detail === "full" || isFailing(validation);
  if (showOutput) {
    lines.push(...renderStream("stdout", validation.stdout, validation.truncated.stdout, detail));
    lines.push(...renderStream("stderr", validation.stderr, validation.truncated.stderr, detail));
  } else {
    lines.push("_Output omitted for a passing validation at detail `summary`._", "");
  }

  return lines;
}

function renderValidations(result: ReviewResult): string[] {
  const lines: string[] = ["## Validations", ""];
  if (result.validations.length === 0) {
    lines.push("_No validations were run._", "");
    return lines;
  }
  for (const validation of result.validations) {
    lines.push(...renderValidation(validation, result.detail));
  }
  return lines;
}

function renderDiagnostic(diagnostic: ResultDiagnostic): string[] {
  const lines = [`- ${codeSpan(diagnostic.code)} — ${oneLine(diagnostic.message)}`];
  if (diagnostic.hint !== undefined) lines.push(`  - Hint: ${oneLine(diagnostic.hint)}`);
  return lines;
}

function renderDiagnostics(result: ReviewResult): string[] {
  // Omitted entirely when empty: an empty section trains readers to skip it.
  if (result.diagnostics.length === 0) return [];

  const lines: string[] = ["## Diagnostics", ""];
  for (const severity of SEVERITY_ORDER) {
    const group = result.diagnostics.filter((d) => d.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${SEVERITY_LABEL[severity]}`, "");
    for (const diagnostic of group) lines.push(...renderDiagnostic(diagnostic));
    lines.push("");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clampNote(droppedBytes: number, maxBytes: number): string {
  return `\n_Report clamped to ${maxBytes} bytes; ${droppedBytes} ${plural(droppedBytes, "byte")} elided._\n`;
}

/**
 * Renders the full Markdown report.
 *
 * The second argument is optional and defaults to unlimited, keeping the
 * signature backward-compatible with `(result) => string`.
 */
export function renderMarkdown(result: ReviewResult, options: RenderMarkdownOptions = {}): string {
  const lines: string[] = [
    ...renderProvenance(result),
    ...renderSummary(result),
    ...renderChanges(result),
    ...renderValidations(result),
    ...renderDiagnostics(result),
  ];

  // Collapse runs of blank lines so section joins stay stable regardless of
  // which sections were emitted.
  const document = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

  const maxBytes = options.maxBytes;
  if (maxBytes === undefined) return document;
  if (Buffer.byteLength(document, "utf8") <= maxBytes) return document;

  // Reserve room for the widest note we could append (the dropped count is at
  // most the original size), so the final string never overshoots the budget.
  const reserve = Buffer.byteLength(clampNote(Buffer.byteLength(document, "utf8"), maxBytes), "utf8");
  const clamped = clampText(document, {
    maxBytes: Math.max(1, maxBytes - reserve),
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  return `${clamped.text.trimEnd()}\n${clampNote(clamped.droppedBytes, maxBytes)}`;
}

/**
 * A 1–4 line plain-text summary, suitable as MCP `content[0].text` beside the
 * machine-readable `structuredContent`.
 *
 * No fences and no headings: this is read as prose in a chat transcript, and a
 * heading here would collide with whatever document the host is assembling.
 */
export function renderTextSummary(result: ReviewResult): string {
  const lines: string[] = [];

  const reason = failureReason(result);
  lines.push(
    result.ok
      ? "Review PASSED: no fatal diagnostics and every executed validation passed."
      : `Review FAILED: ${reason ?? "the review reported a non-ok result"}.`,
  );

  const counts = result.changes.counts;
  const scopes = orderedScopes(result);
  const perScope = scopes.map((scope) => `${scope} ${counts[scope]}`).join(", ");
  lines.push(
    `Changes: ${counts.distinctFiles} distinct ${plural(counts.distinctFiles, "file")}` +
      `${perScope ? ` (${perScope})` : ""}.`,
  );

  if (result.validations.length > 0) {
    const failing = failingValidations(result);
    const passed = result.validations.length - failing.length;
    lines.push(`Validations: ${passed} passed, ${failing.length} not passed.`);
    if (failing.length > 0) {
      lines.push(`Failing: ${failing.map((v) => `${oneLine(v.id)} (${v.status})`).join(", ")}.`);
    }
  } else if (result.diagnostics.length > 0) {
    lines.push(
      `Diagnostics: ${result.diagnostics.length} ${plural(result.diagnostics.length, "entry", "entries")}.`,
    );
  }

  // Hard cap at four lines; the contract is a glanceable blurb, not a report.
  return lines.slice(0, 4).map(oneLine).join("\n");
}
