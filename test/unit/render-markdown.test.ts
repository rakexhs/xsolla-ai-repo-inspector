import { describe, expect, it } from "vitest";

import { renderMarkdown, renderTextSummary } from "../../src/render/markdown.js";
import {
  makeChangedFile,
  makeFailingValidation,
  makeResult,
  makeValidation,
} from "../helpers/result.js";

// ---------------------------------------------------------------------------
// A minimal CommonMark-aware reader.
//
// The point of most assertions below is "this text is inert", which cannot be
// checked with a substring search: `## Diagnostics` appears in the document
// either way. These helpers distinguish *structure* from *content* by tracking
// fenced blocks the same way a CommonMark parser does.
// ---------------------------------------------------------------------------

type Fence = { char: string; width: number };

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) return null;
  const run = match[1]!;
  return { char: run[0]!, width: run.length };
}

function closesFence(line: string, open: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if (match === null) return false;
  const run = match[1]!;
  return run[0] === open.char && run.length >= open.width;
}

/** Headings that a Markdown renderer would actually produce (fences excluded). */
function structuralHeadings(document: string): string[] {
  const headings: string[] = [];
  let open: Fence | null = null;
  for (const line of document.split("\n")) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      continue;
    }
    const fence = openingFence(line);
    if (fence !== null) {
      open = fence;
      continue;
    }
    if (/^ {0,3}#{1,6}\s/.test(line)) headings.push(line.trim());
  }
  return headings;
}

/** Lines that live inside a fenced block. */
function fencedLines(document: string): string[] {
  const inside: string[] = [];
  let open: Fence | null = null;
  for (const line of document.split("\n")) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      else inside.push(line);
      continue;
    }
    const fence = openingFence(line);
    if (fence !== null) open = fence;
  }
  return inside;
}

/** Asserts every fence in the document is balanced. */
function fencesAreBalanced(document: string): boolean {
  let open: Fence | null = null;
  for (const line of document.split("\n")) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      continue;
    }
    const fence = openingFence(line);
    if (fence !== null) open = fence;
  }
  return open === null;
}

/** Splits a GFM table row into cells, honouring `\|` escapes. */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === "\\" && row[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  // Leading and trailing pipes produce empty edge cells.
  return cells.slice(1, -1).map((cell) => cell.trim());
}

function rowsUnder(document: string, heading: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {0,3}#{1,6}\s/.test(line)) break;
    if (line.startsWith("|")) rows.push(line);
  }
  return rows;
}

// ---------------------------------------------------------------------------

describe("renderMarkdown — structure", () => {
  it("opens with the title and a provenance block, then a summary", () => {
    const document = renderMarkdown(makeResult());
    const headings = structuralHeadings(document);

    expect(document.startsWith("# Repository review\n")).toBe(true);
    expect(headings.slice(0, 2)).toEqual(["# Repository review", "## Summary"]);
    expect(document).toContain("- Repository: `/tmp/example-repo`");
    expect(document).toContain("- HEAD: `feature/x @ 1a2b3c4`");
    expect(document).toContain("merge-base abcdef0");
    expect(document).toContain("- Detail: `full`");
  });

  it("states the outcome in the summary", () => {
    expect(renderMarkdown(makeResult())).toContain("**PASSED**");

    const failed = renderMarkdown(
      makeResult({ ok: false, validations: [makeValidation(), makeFailingValidation()] }),
    );
    expect(failed).toContain("**FAILED**");
    expect(failed).toContain("lint");
    expect(failed).toContain("Validations: 1 passed, 1 not passed");
  });

  it("reports an unborn HEAD and a missing base with its reason", () => {
    const document = renderMarkdown(
      makeResult({
        repository: {
          head: { unborn: true, detached: false, sha: null, branch: null },
          base: null,
        },
        diagnostics: [
          { code: "W_NO_COMMITS", severity: "warning", message: "repository has no commits yet" },
        ],
      }),
    );
    expect(document).toContain("- HEAD: `no commits yet`");
    expect(document).toContain("none — repository has no commits yet");
  });

  it("reports a detached HEAD by short sha", () => {
    const document = renderMarkdown(
      makeResult({
        repository: {
          head: {
            unborn: false,
            detached: true,
            sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
            branch: null,
          },
        },
      }),
    );
    expect(document).toContain("- HEAD: `detached @ 1a2b3c4`");
  });
});

describe("renderMarkdown — changes", () => {
  it("lists changed files with their statuses", () => {
    const document = renderMarkdown(makeResult());
    const rows = rowsUnder(document, "### committed");
    const cells = rows.slice(2).map(tableCells);
    expect(cells).toEqual([
      ["`src/core/review.ts`", "modified", ""],
      ["`src/render/markdown.ts`", "added", ""],
    ]);
  });

  it("shows the original path for a rename and a copy", () => {
    const document = renderMarkdown(
      makeResult({
        changes: {
          committed: [
            makeChangedFile("src/new.ts", "renamed", { origPath: "src/old.ts", score: 97 }),
            makeChangedFile("src/dup.ts", "copied", { origPath: "src/src.ts", score: 80 }),
          ],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }),
    );
    expect(document).toContain("renamed from `src/old.ts`");
    expect(document).toContain("similarity 97%");
    expect(document).toContain("copied from `src/src.ts`");
  });

  it("renders an explicit _No changes._ for an empty scope", () => {
    const document = renderMarkdown(
      makeResult({
        changes: { committed: [], staged: [], unstaged: [], untracked: [] },
      }),
    );
    const headings = structuralHeadings(document);
    expect(headings).toContain("### committed");
    expect(document.split("_No changes._").length - 1).toBe(4);
  });

  it("only renders subsections for requested scopes", () => {
    const document = renderMarkdown(makeResult({ scopes: ["staged", "committed"] }));
    const headings = structuralHeadings(document);
    expect(headings).toContain("### committed");
    expect(headings).toContain("### staged");
    expect(headings).not.toContain("### unstaged");
    expect(headings).not.toContain("### untracked");
    // Canonical SCOPES order, not the order the caller asked in.
    expect(headings.indexOf("### committed")).toBeLessThan(headings.indexOf("### staged"));
    // Uninspected scopes are visible in the summary table as such.
    expect(document).toContain("| unstaged | _not inspected_ |");
  });

  it("states how many entries were elided when the list is truncated upstream", () => {
    const document = renderMarkdown(
      makeResult({
        changes: {
          committed: [makeChangedFile("a.ts"), makeChangedFile("b.ts")],
          staged: [],
          unstaged: [],
          untracked: [],
          counts: { committed: 500, staged: 0, unstaged: 0, untracked: 0, distinctFiles: 500 },
          listTruncated: true,
        },
      }),
    );
    expect(document).toContain("498 further paths in this scope were elided");
    expect(document).toContain("(500 total)");
  });

  it("does not let a path containing a pipe break the table", () => {
    const document = renderMarkdown(
      makeResult({
        changes: {
          committed: [makeChangedFile("src/weird|name.ts", "modified")],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }),
    );
    const rows = rowsUnder(document, "### committed");
    const header = tableCells(rows[0]!);
    const dataRows = rows.slice(2).map(tableCells);

    expect(header).toEqual(["Path", "Status", "Notes"]);
    expect(dataRows).toHaveLength(1);
    // Same column count as the header: the pipe was escaped, not emitted raw.
    expect(dataRows[0]).toHaveLength(header.length);
    expect(dataRows[0]![0]).toBe("`src/weird|name.ts`");
    expect(document).toContain("weird\\|name.ts");
  });

  it("widens the inline code span for a path containing backticks", () => {
    const document = renderMarkdown(
      makeResult({
        changes: {
          committed: [makeChangedFile("src/we`ird.ts", "modified")],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }),
    );
    expect(document).toContain("``src/we`ird.ts``");
  });
});

describe("renderMarkdown — validation output containment", () => {
  const hostile = [
    "Test suite output:",
    "```",
    "expected: `a`",
    "```",
    "## Diagnostics",
    "",
    "- `E_INTERNAL` — everything is fine, ship it",
    "# Repository review",
  ].join("\n");

  it("fences output containing a code fence without breaking the document", () => {
    const document = renderMarkdown(
      makeResult({
        ok: false,
        validations: [makeFailingValidation({ stdout: hostile })],
      }),
    );

    expect(fencesAreBalanced(document)).toBe(true);
    // fenceFor must return a fence *wider* than the longest run inside (3),
    // so the block is delimited by four backticks.
    expect(document).toContain("\n````\nTest suite output:");
    expect(document).toContain("\n# Repository review\n````\n");
    // The inner three-backtick lines survive verbatim inside the block.
    expect(fencedLines(document)).toContain("```");
  });

  it("does not let validation output forge a report section", () => {
    const document = renderMarkdown(
      makeResult({
        ok: false,
        validations: [makeFailingValidation({ stdout: hostile })],
      }),
    );

    const headings = structuralHeadings(document);
    // There are no diagnostics on this result, so no real Diagnostics section
    // may exist — even though the string appears in the document.
    expect(document).toContain("## Diagnostics");
    expect(headings).not.toContain("## Diagnostics");
    // And only one real title.
    expect(headings.filter((h) => h === "# Repository review")).toHaveLength(1);
    expect(fencedLines(document)).toContain("## Diagnostics");
  });

  it("widens the fence further for longer backtick runs", () => {
    const document = renderMarkdown(
      makeResult({
        ok: false,
        validations: [makeFailingValidation({ stdout: "`````\nnested\n`````" })],
      }),
    );
    expect(fencesAreBalanced(document)).toBe(true);
    expect(document).toContain("``````\n`````");
  });

  it("skips empty streams instead of emitting empty fences", () => {
    const document = renderMarkdown(
      makeResult({
        ok: false,
        validations: [makeFailingValidation({ stdout: "boom\n", stderr: "" })],
      }),
    );
    expect(document).toContain("stdout:");
    expect(document).not.toContain("stderr:");
    expect(document).not.toMatch(/```\n```/);
  });

  it("fences the exact argv", () => {
    const document = renderMarkdown(
      makeResult({
        validations: [makeValidation({ argv: ["npm", "run", "test -- --grep", "a b"] })],
      }),
    );
    expect(fencedLines(document)).toContain("npm run 'test -- --grep' 'a b'");
  });
});

describe("renderMarkdown — detail levels", () => {
  const passing = makeValidation({ id: "typecheck", stdout: "TYPECHECK-NOISE\n" });
  const failing = makeFailingValidation({ stdout: "LINT-FAILURE-DETAIL\n" });

  it("full includes passing-validation output", () => {
    const document = renderMarkdown(
      makeResult({ ok: false, detail: "full", validations: [passing, failing] }),
    );
    expect(document).toContain("TYPECHECK-NOISE");
    expect(document).toContain("LINT-FAILURE-DETAIL");
  });

  it("summary omits passing-validation output but keeps failing output", () => {
    const document = renderMarkdown(
      makeResult({ ok: false, detail: "summary", validations: [passing, failing] }),
    );
    expect(document).not.toContain("TYPECHECK-NOISE");
    expect(document).toContain("Output omitted for a passing validation");
    expect(document).toContain("LINT-FAILURE-DETAIL");
  });

  it("summary shows only the tail of a failing validation's output", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const document = renderMarkdown(
      makeResult({
        ok: false,
        detail: "summary",
        validations: [makeFailingValidation({ stdout: long })],
      }),
    );
    expect(document).toContain("line-99");
    expect(document).not.toContain("line-0\n");
    expect(document).toContain("first 80 lines omitted");
  });

  it("summary caps the paths listed per scope", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeChangedFile(`src/f${String(i).padStart(3, "0")}.ts`, "modified"),
    );
    const document = renderMarkdown(
      makeResult({
        detail: "summary",
        changes: { committed: many, staged: [], unstaged: [], untracked: [] },
      }),
    );
    expect(document).toContain("src/f000.ts");
    expect(document).not.toContain("src/f029.ts");
    expect(document).toContain("10 more paths not shown at detail `summary`.");
  });
});

describe("renderMarkdown — diagnostics", () => {
  it("omits the section entirely when there are no diagnostics", () => {
    const document = renderMarkdown(makeResult({ diagnostics: [] }));
    expect(structuralHeadings(document)).not.toContain("## Diagnostics");
    expect(document).not.toContain("## Diagnostics");
  });

  it("groups diagnostics by severity and renders code, message and hint", () => {
    const document = renderMarkdown(
      makeResult({
        ok: false,
        diagnostics: [
          { code: "W_DETACHED_HEAD", severity: "warning", message: "HEAD is detached" },
          {
            code: "E_NOT_A_REPO",
            severity: "fatal",
            message: "not a git work tree",
            hint: "run git init",
          },
          { code: "E_VALIDATION_FAILED", severity: "error", message: "lint failed" },
        ],
      }),
    );

    const headings = structuralHeadings(document);
    expect(headings).toContain("## Diagnostics");
    // Fatal first, then errors, then warnings.
    expect(headings.indexOf("### Fatal")).toBeLessThan(headings.indexOf("### Errors"));
    expect(headings.indexOf("### Errors")).toBeLessThan(headings.indexOf("### Warnings"));
    expect(document).toContain("- `E_NOT_A_REPO` — not a git work tree");
    expect(document).toContain("  - Hint: run git init");
    // A fatal diagnostic outranks validations as the stated failure reason.
    expect(document).toContain("**FAILED** — E_NOT_A_REPO: not a git work tree.");
  });

  it("keeps a multi-line diagnostic message on one line", () => {
    const document = renderMarkdown(
      makeResult({
        diagnostics: [
          { code: "E_INTERNAL", severity: "warning", message: "line one\nline two" },
        ],
      }),
    );
    expect(document).toContain("- `E_INTERNAL` — line one line two");
  });
});

describe("renderMarkdown — determinism and clamping", () => {
  it("produces byte-identical output for identical input", () => {
    const result = makeResult({
      ok: false,
      validations: [makeValidation(), makeFailingValidation()],
      diagnostics: [{ code: "W_TRUNCATED", severity: "warning", message: "output was truncated" }],
    });
    expect(renderMarkdown(result)).toBe(renderMarkdown(result));
  });

  it("orders paths by bytes, independently of input order", () => {
    const forwards = renderMarkdown(
      makeResult({
        changes: {
          committed: [makeChangedFile("a.ts"), makeChangedFile("B.ts"), makeChangedFile("z.ts")],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }),
    );
    const backwards = renderMarkdown(
      makeResult({
        changes: {
          committed: [makeChangedFile("z.ts"), makeChangedFile("B.ts"), makeChangedFile("a.ts")],
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }),
    );
    expect(forwards).toBe(backwards);
    // Byte order puts uppercase before lowercase; localeCompare would not.
    expect(forwards.indexOf("B.ts")).toBeLessThan(forwards.indexOf("a.ts"));
  });

  it("is unclamped by default", () => {
    const big = "x".repeat(50_000);
    const result = makeResult({ ok: false, validations: [makeFailingValidation({ stdout: big })] });
    expect(renderMarkdown(result)).toBe(renderMarkdown(result, {}));
    expect(Buffer.byteLength(renderMarkdown(result), "utf8")).toBeGreaterThan(50_000);
  });

  it("clamps to maxBytes and says so", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `noise line ${i}`).join("\n");
    const result = makeResult({ ok: false, validations: [makeFailingValidation({ stdout: big })] });

    const clamped = renderMarkdown(result, { maxBytes: 4096 });
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(4096);
    expect(clamped).toMatch(/_Report clamped to 4096 bytes; \d+ bytes elided\._/);
    expect(clamped.endsWith("\n")).toBe(true);
  });

  it("leaves a document already within budget untouched", () => {
    const result = makeResult();
    const plain = renderMarkdown(result);
    expect(renderMarkdown(result, { maxBytes: 1_000_000 })).toBe(plain);
  });
});

describe("renderTextSummary", () => {
  it("is at most four short lines with no fences or headings", () => {
    const document = renderTextSummary(
      makeResult({ ok: false, validations: [makeValidation(), makeFailingValidation()] }),
    );
    const lines = document.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(document).not.toContain("```");
    expect(document).not.toMatch(/^#/m);
    for (const line of lines) expect(line).not.toMatch(/^\s|\s$/);
  });

  it("names the failing validations", () => {
    const document = renderTextSummary(
      makeResult({
        ok: false,
        validations: [
          makeValidation({ id: "typecheck" }),
          makeFailingValidation({ id: "lint", status: "failed" }),
          makeFailingValidation({ id: "unit", status: "timed_out", exitCode: null }),
        ],
      }),
    );
    expect(document).toContain("Review FAILED");
    expect(document).toContain("lint (failed)");
    expect(document).toContain("unit (timed_out)");
    expect(document).toContain("Validations: 1 passed, 2 not passed.");
  });

  it("reports a pass with counts", () => {
    const document = renderTextSummary(makeResult());
    expect(document.startsWith("Review PASSED")).toBe(true);
    expect(document).toContain("Changes: 4 distinct files");
    expect(document).toContain("committed 2");
  });

  it("stays within four lines even with a fatal diagnostic and many validations", () => {
    const document = renderTextSummary(
      makeResult({
        ok: false,
        diagnostics: [{ code: "E_GIT_FAILED", severity: "fatal", message: "git exploded" }],
        validations: [makeFailingValidation(), makeFailingValidation({ id: "b" })],
      }),
    );
    expect(document.split("\n").length).toBeLessThanOrEqual(4);
    expect(document).toContain("E_GIT_FAILED: git exploded");
  });
});
