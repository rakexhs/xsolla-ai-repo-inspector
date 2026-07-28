#!/usr/bin/env node
/**
 * The CLI adapter.
 *
 * This file is deliberately thin: it parses, resolves trust, calls
 * `reviewRepository`, renders, writes, and picks an exit code. It contains no
 * Git knowledge, no execution policy and no result shaping — those live in the
 * core, shared byte-for-byte with the MCP adapter.
 *
 * Two rules are absolute here, because both were violated by the starter and
 * both are the kind of violation that silently corrupts a pipeline:
 *
 *  1. **stdout carries the report and nothing else.** Every confirmation,
 *     warning and error goes to stderr. `--format json | jq` must work, and it
 *     only works if not one stray log line can ever reach stdout.
 *  2. **No raw Error and no stack trace for a handled failure.** The starter
 *     printed a Node error object containing `[Circular *1]` across several
 *     screens for something as ordinary as a bad ref. Failures are reduced to
 *     one line through `describeError`/`Diagnostic`; a stack appears only under
 *     `--debug`, and only for a genuinely unexpected throw.
 *
 * Exit codes come from `exitCodeForResult`, never from local guesswork, and
 * they are set via `process.exitCode` rather than `process.exit()` so that a
 * large report on a pipe is fully flushed before the process ends. Calling
 * `process.exit()` after writing to a piped stdout truncates the output.
 */

import { writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as path from "node:path";

import type { ExitCode } from "../core/errors.js";
import { EXIT_CODES, describeError, exitCodeForDiagnostic } from "../core/errors.js";
import { exitCodeForResult } from "../core/exit.js";
import { reviewRepository } from "../core/review.js";
import { CLI_LIMITS, type Limits, type ReviewRequest, type ReviewResult } from "../core/types.js";
import { renderJson } from "../render/json.js";
import { renderMarkdown } from "../render/markdown.js";
import { loadConfig, planValidations } from "../validation/config.js";
import { parseArgs, type ReviewArgs } from "./args.js";
import { helpHint, helpText, versionText } from "./help.js";

// ---------------------------------------------------------------------------
// Output channels
// ---------------------------------------------------------------------------

/** The report. Nothing else may ever be written here. */
function out(text: string): void {
  process.stdout.write(text);
}

/** Everything a human or a log needs to see. */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Collapses to a single line so a message can never be mistaken for a report. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/**
 * One diagnostic, one line, hint included inline.
 *
 * The hint is worth more than the line saving: an agent reading stderr gets the
 * corrective action in the same read, and a human is not left guessing.
 */
/**
 * Structural rather than `Diagnostic`, because the diagnostics carried on a
 * `ReviewResult` are zod-inferred and their `hint?: string | undefined` is not
 * assignable to the hand-written `hint?: string` under
 * `exactOptionalPropertyTypes`. Printing accepts both.
 */
type PrintableDiagnostic = {
  code: string;
  message: string;
  hint?: string | undefined;
};

function formatDiagnostic(diagnostic: PrintableDiagnostic): string {
  const hint = diagnostic.hint === undefined ? "" : ` (${oneLine(diagnostic.hint)})`;
  return `inspector: ${diagnostic.code}: ${oneLine(diagnostic.message)}${hint}`;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * CLI defaults with the two documented overrides applied.
 *
 * The `Math.max` calls exist because the caps interact: raising the per-stream
 * cap above the whole-document cap, or the per-validation timeout above the
 * total budget, would leave the user's override quietly ineffective. Raising a
 * limit must actually raise it.
 */
function resolveLimits(args: ReviewArgs): Limits {
  const limits: Limits = { ...CLI_LIMITS };

  if (args.maxOutputBytes !== undefined) {
    limits.maxOutputBytesPerStream = args.maxOutputBytes;
    limits.maxTotalBytes = Math.max(CLI_LIMITS.maxTotalBytes, args.maxOutputBytes);
  }
  if (args.timeoutMs !== undefined) {
    limits.validationTimeoutMs = args.timeoutMs;
    limits.totalValidationBudgetMs = Math.max(
      CLI_LIMITS.totalValidationBudgetMs,
      args.timeoutMs,
    );
  }

  return limits;
}

// ---------------------------------------------------------------------------
// Repository path
// ---------------------------------------------------------------------------

/**
 * Canonicalises `--repo`.
 *
 * `realpath` is what makes `repository.path` stable and comparable (on macOS
 * `/tmp` is a symlink to `/private/tmp`, and the CLI/MCP consistency test
 * compares these strings). A path that does not exist is *not* handled here:
 * it falls through to the core, which owns the `E_NOT_A_REPO` message and its
 * exit code 3. Duplicating that check would mean two different messages for the
 * same condition depending on which adapter you used.
 */
async function canonicalRepoPath(repo: string): Promise<string> {
  const resolved = path.resolve(repo);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    err(formatDiagnostic(parsed.diagnostic));
    err(helpHint());
    process.exitCode = EXIT_CODES.USAGE;
    return;
  }

  if (parsed.args.mode === "help") {
    out(helpText());
    process.exitCode = EXIT_CODES.OK;
    return;
  }
  if (parsed.args.mode === "version") {
    out(`${versionText()}\n`);
    process.exitCode = EXIT_CODES.OK;
    return;
  }

  const args: ReviewArgs = parsed.args;
  const repositoryPath = await canonicalRepoPath(args.repo);
  const limits = resolveLimits(args);

  // --- Trust: where the allowlist comes from --------------------------------
  const configResult = await loadConfig({
    ...(args.config !== undefined ? { explicitPath: args.config } : {}),
    repositoryPath,
    allowRepoConfig: args.allowRepoConfig,
  });

  const fatalConfig = configResult.diagnostics.filter((d) => d.severity === "fatal");
  for (const diagnostic of configResult.diagnostics) err(formatDiagnostic(diagnostic));
  if (fatalConfig.length > 0) {
    const first = fatalConfig[0];
    process.exitCode =
      first === undefined ? EXIT_CODES.USAGE : exitCodeForDiagnostic(first.code);
    return;
  }

  // --- Trust: which entries this caller may run -----------------------------
  // `adHocAllowed: true` is the CLI's defining privilege. The operator typed the
  // command themselves, so there is no confused deputy; the MCP surface passes
  // false because there the repository and the command both come from a model.
  const plan = planValidations({
    config: configResult.config,
    names: args.validation,
    adHoc: args.validate,
    adHocAllowed: true,
    defaultTimeoutMs: limits.validationTimeoutMs,
  });

  if (plan.errors.length > 0) {
    for (const diagnostic of plan.errors) err(formatDiagnostic(diagnostic));
    const first = plan.errors[0];
    process.exitCode =
      first === undefined ? EXIT_CODES.USAGE : exitCodeForDiagnostic(first.code);
    return;
  }

  // --- Review ---------------------------------------------------------------
  const request: ReviewRequest = {
    repositoryPath,
    ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
    scopes: args.scopes,
    detail: args.detail,
    validations: plan.planned,
    denied: plan.denied,
    limits,
  };

  const result: ReviewResult = await reviewRepository(request);

  // --- Render ---------------------------------------------------------------
  const report = args.format === "json" ? renderJson(result) : renderMarkdown(result);

  if (args.out === "-") {
    out(report);
  } else {
    const target = path.resolve(args.out);
    try {
      writeFileSync(target, report, "utf8");
    } catch (error) {
      err(`inspector: could not write report to ${target}: ${describeError(error)}`);
      process.exitCode = EXIT_CODES.USAGE;
      return;
    }
    // Confirmation on stderr: with `--out` the user asked for the report to go
    // somewhere else, so stdout must stay empty and scriptable.
    err(`inspector: report written to ${target}`);
  }

  // Fatal diagnostics are echoed to stderr so a failure is visible even when
  // the report went to a file. Warnings are not: they are in the report, and
  // stderr is for things that changed the outcome.
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === "fatal") err(formatDiagnostic(diagnostic));
  }

  const code: ExitCode = args.exitZero ? EXIT_CODES.OK : exitCodeForResult(result);
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `--debug` is read straight from argv here rather than from the parsed args,
 * because this handler must also work for a throw that happened *during*
 * parsing.
 */
function debugRequested(argv: readonly string[]): boolean {
  return argv.includes("--debug");
}

const argv = process.argv.slice(2);

main(argv).catch((error: unknown) => {
  // The last line of defence. One line, no object dump, no `[Circular *1]`.
  err(`inspector: internal error: ${oneLine(describeError(error))}`);
  if (debugRequested(argv) && error instanceof Error && error.stack !== undefined) {
    err(error.stack);
  } else if (!debugRequested(argv)) {
    err("inspector: re-run with --debug for a stack trace.");
  }
  process.exitCode = EXIT_CODES.INTERNAL;
});
