/**
 * The **single** place a `ReviewResult` becomes JSON.
 *
 * Both public surfaces go through `toStructuredContent`:
 *
 *   - the CLI's `--format json` (via `renderJson`), and
 *   - the MCP tool's `structuredContent` field.
 *
 * That is deliberate and load-bearing. If either adapter serialised a result
 * independently — even with a bare `JSON.stringify(result)` — the two
 * interfaces would be free to drift: one could grow a field, reorder keys, or
 * emit `null` where the other omits the key, and no test would notice. Routing
 * both through this function is what makes the cross-interface consistency test
 * meaningful: it compares two byte strings that provably came from the same
 * projection.
 *
 * Two invariants this module maintains:
 *
 *   1. **Deterministic key order.** Every object is rebuilt field by field in a
 *      fixed order rather than relying on `JSON.stringify` walking whatever
 *      insertion order the producing code happened to use. Two runs over the
 *      same repository state therefore produce byte-identical JSON.
 *   2. **Absent optionals are omitted, never `null`.** The MCP SDK validates
 *      `structuredContent` against the advertised `outputSchema` (derived from
 *      `ReviewResultSchema`) and throws an `McpError` on a mismatch. `origPath`,
 *      `score`, `reason` and `hint` are `.optional()`, not `.nullable()`, so
 *      emitting an explicit `null` would fail that validation at runtime.
 *
 * No timestamps are introduced here, and the only absolute path in the output
 * is `repository.path`, which the result already carries.
 */

import type {
  ChangedFile,
  ChangeSet,
  FileSummary,
  HeadInfo,
  RepositoryInfo,
  ResolvedBase,
  ReviewResult,
  TruncationInfo,
  ValidationOutcome,
} from "../core/types.js";

type Json = Record<string, unknown>;

/**
 * The diagnostic shape as the *schema* infers it.
 *
 * `errors.ts` also exports a hand-written `Diagnostic`, but under
 * `exactOptionalPropertyTypes` its `hint?: string` is not assignable from zod's
 * `hint?: string | undefined`. Deriving from the result type keeps this module
 * pinned to whatever `ReviewResultSchema` actually says.
 */
type ResultDiagnostic = ReviewResult["diagnostics"][number];

function changedFileToJson(file: ChangedFile): Json {
  const out: Json = {
    path: file.path,
    status: file.status,
  };
  if (file.kind !== undefined) out["kind"] = file.kind;
  // Optional: present only when git reported a rename/copy source.
  if (file.origPath !== undefined) out["origPath"] = file.origPath;
  if (file.score !== undefined) out["score"] = file.score;
  return out;
}

function fileSummaryToJson(file: FileSummary): Json {
  const out: Json = {
    path: file.path,
    status: file.status,
    scopes: [...file.scopes],
  };
  if (file.kind !== undefined) out["kind"] = file.kind;
  return out;
}

function changeSetToJson(changes: ChangeSet): Json {
  return {
    committed: changes.committed.map(changedFileToJson),
    staged: changes.staged.map(changedFileToJson),
    unstaged: changes.unstaged.map(changedFileToJson),
    untracked: changes.untracked.map(changedFileToJson),
    files: changes.files.map(fileSummaryToJson),
    counts: {
      committed: changes.counts.committed,
      staged: changes.counts.staged,
      unstaged: changes.counts.unstaged,
      untracked: changes.counts.untracked,
      distinctFiles: changes.counts.distinctFiles,
    },
    listTruncated: changes.listTruncated,
  };
}

function headToJson(head: HeadInfo): Json {
  return {
    unborn: head.unborn,
    detached: head.detached,
    sha: head.sha,
    branch: head.branch,
  };
}

function baseToJson(base: ResolvedBase): Json {
  return {
    requested: base.requested,
    ref: base.ref,
    sha: base.sha,
    mergeBase: base.mergeBase,
    autoDetected: base.autoDetected,
  };
}

function repositoryToJson(repository: RepositoryInfo): Json {
  return {
    path: repository.path,
    head: headToJson(repository.head),
    // `base` is nullable (not optional): an explicit null is correct here and
    // is what the schema expects when no base could be resolved.
    base: repository.base === null ? null : baseToJson(repository.base),
  };
}

function validationToJson(validation: ValidationOutcome): Json {
  const out: Json = {
    id: validation.id,
    argv: [...validation.argv],
    status: validation.status,
    exitCode: validation.exitCode,
    signal: validation.signal,
    durationMs: validation.durationMs,
    stdout: validation.stdout,
    stderr: validation.stderr,
    truncated: {
      stdout: validation.truncated.stdout,
      stderr: validation.truncated.stderr,
    },
  };
  if (validation.outputBytesDropped !== undefined) {
    out["outputBytesDropped"] = {
      stdout: validation.outputBytesDropped.stdout,
      stderr: validation.outputBytesDropped.stderr,
    };
  }
  if (validation.reason !== undefined) out["reason"] = validation.reason;
  return out;
}

function diagnosticToJson(diagnostic: ResultDiagnostic): Json {
  const out: Json = {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
  };
  if (diagnostic.hint !== undefined) out["hint"] = diagnostic.hint;
  return out;
}

function truncationToJson(truncation: TruncationInfo): Json {
  return {
    applied: truncation.applied,
    droppedBytes: truncation.droppedBytes,
    fields: [...truncation.fields],
  };
}

/**
 * Projects a `ReviewResult` onto a plain, JSON-safe object with a fixed key
 * order and no `undefined` values.
 *
 * Round-trips: `ReviewResultSchema.parse(toStructuredContent(result))` succeeds
 * for any valid result. That is asserted by a test, because it is the property
 * the MCP SDK relies on when it validates `structuredContent` against the
 * advertised `outputSchema`.
 */
export function toStructuredContent(result: ReviewResult): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    ok: result.ok,
    detail: result.detail,
    scopes: [...result.scopes],
    repository: repositoryToJson(result.repository),
    changes: changeSetToJson(result.changes),
    validations: result.validations.map(validationToJson),
    diagnostics: result.diagnostics.map(diagnosticToJson),
    truncation: truncationToJson(result.truncation),
  };
}

/**
 * The CLI's `--format json` output: two-space indent, exactly one trailing
 * newline so the file is POSIX-clean and `diff`-friendly.
 */
export function renderJson(result: ReviewResult): string {
  return `${JSON.stringify(toStructuredContent(result), null, 2)}\n`;
}
