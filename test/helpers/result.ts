/**
 * Shared fixtures for building `ReviewResult` values in tests.
 *
 * Every suite that needs a result should build it from `makeResult` rather than
 * hand-rolling a literal: the baseline is guaranteed to satisfy
 * `ReviewResultSchema.parse`, so a schema change breaks one file instead of
 * twenty, and tests stay focused on the field they actually care about.
 */

import {
  SCHEMA_VERSION,
  STATUS_PRECEDENCE,
  type ChangeCounts,
  type ChangedFile,
  type ChangeSet,
  type FileStatus,
  type FileSummary,
  type ReviewResult,
  type Scope,
  type ValidationOutcome,
} from "../../src/core/types.js";
import { comparePaths } from "../../src/core/text.js";

/**
 * Recursive partial. Arrays are replaced wholesale (merging them element-wise
 * would make "set this scope to exactly these two files" impossible to express).
 */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where arrays and primitives from `override` win outright. */
function mergeDeep<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as unknown as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value;
  }
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/** A changed file. Optional keys are added conditionally for `exactOptionalPropertyTypes`. */
export function makeChangedFile(
  path: string,
  status: FileStatus = "modified",
  extra: { origPath?: string; score?: number; kind?: "directory" } = {},
): ChangedFile {
  const file: ChangedFile = { path, status };
  if (extra.origPath !== undefined) file.origPath = extra.origPath;
  if (extra.score !== undefined) file.score = extra.score;
  if (extra.kind !== undefined) file.kind = extra.kind;
  return file;
}

/** A validation outcome; defaults to a fast, passing typecheck. */
export function makeValidation(
  overrides: DeepPartial<ValidationOutcome> = {},
): ValidationOutcome {
  const base: ValidationOutcome = {
    id: "typecheck",
    argv: ["npx", "tsc", "--noEmit"],
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 1200,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
  return mergeDeep(base, overrides);
}

/** A failing validation with output on both streams. */
export function makeFailingValidation(
  overrides: DeepPartial<ValidationOutcome> = {},
): ValidationOutcome {
  return makeValidation(
    mergeDeep<ValidationOutcome>(
      {
        id: "lint",
        argv: ["npx", "eslint", "."],
        status: "failed",
        exitCode: 1,
        signal: null,
        durationMs: 3400,
        stdout: "src/a.ts:1:1 error no-unused-vars\n",
        stderr: "1 problem\n",
        truncated: { stdout: false, stderr: false },
      },
      overrides,
    ),
  );
}

// ---------------------------------------------------------------------------
// Derived change bookkeeping
// ---------------------------------------------------------------------------

function statusRank(status: FileStatus): number {
  const index = STATUS_PRECEDENCE.indexOf(status);
  return index === -1 ? STATUS_PRECEDENCE.length : index;
}

function countsFrom(changes: Pick<ChangeSet, Scope>, files: FileSummary[]): ChangeCounts {
  return {
    committed: changes.committed.length,
    staged: changes.staged.length,
    unstaged: changes.unstaged.length,
    untracked: changes.untracked.length,
    distinctFiles: files.length,
  };
}

/** One row per distinct path, unioned across scopes, using STATUS_PRECEDENCE. */
function summariesFrom(changes: Pick<ChangeSet, Scope>): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const scope of ["committed", "staged", "unstaged", "untracked"] as const) {
    for (const file of changes[scope]) {
      const existing = byPath.get(file.path);
      if (existing === undefined) {
        byPath.set(file.path, {
          path: file.path,
          status: file.status,
          scopes: [scope],
          ...(file.kind === "directory" ? { kind: "directory" as const } : {}),
        });
        continue;
      }
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
      if (statusRank(file.status) < statusRank(existing.status)) existing.status = file.status;
    }
  }
  return [...byPath.values()].sort((a, b) => comparePaths(a.path, b.path));
}

// ---------------------------------------------------------------------------
// Baseline result
// ---------------------------------------------------------------------------

const HEAD_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const BASE_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
const MERGE_BASE_SHA = "abcdef0123456789abcdef0123456789abcdef01";

function baseline(): ReviewResult {
  const committed: ChangedFile[] = [
    makeChangedFile("src/core/review.ts", "modified"),
    makeChangedFile("src/render/markdown.ts", "added"),
  ];
  const staged: ChangedFile[] = [makeChangedFile("README.md", "modified")];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [makeChangedFile("notes.txt", "untracked")];
  const scoped = { committed, staged, unstaged, untracked };
  const files = summariesFrom(scoped);

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    detail: "full",
    scopes: ["committed", "staged", "unstaged", "untracked"],
    repository: {
      path: "/tmp/example-repo",
      head: { unborn: false, detached: false, sha: HEAD_SHA, branch: "feature/x" },
      base: {
        requested: null,
        ref: "origin/main",
        sha: BASE_SHA,
        mergeBase: MERGE_BASE_SHA,
        autoDetected: true,
      },
    },
    changes: { ...scoped, files, counts: countsFrom(scoped, files), listTruncated: false },
    validations: [makeValidation()],
    diagnostics: [],
    truncation: { applied: false, droppedBytes: 0, fields: [] },
  };
}

/**
 * A valid baseline `ReviewResult` with `overrides` deep-merged in.
 *
 * Convenience: when a caller replaces one of the four scope arrays without also
 * supplying `changes.counts` / `changes.files`, those are recomputed from the
 * new arrays. Without that, overriding `changes.committed` would silently leave
 * the counts describing the old fixture and every count assertion would be a
 * test of the fixture rather than of the code under test.
 */
export function makeResult(overrides: DeepPartial<ReviewResult> = {}): ReviewResult {
  const merged = mergeDeep(baseline(), overrides);

  const changeOverrides = overrides.changes;
  const scopesTouched =
    changeOverrides !== undefined &&
    (["committed", "staged", "unstaged", "untracked"] as const).some(
      (scope) => changeOverrides[scope] !== undefined,
    );

  if (scopesTouched) {
    const scoped = {
      committed: merged.changes.committed,
      staged: merged.changes.staged,
      unstaged: merged.changes.unstaged,
      untracked: merged.changes.untracked,
    };
    if (changeOverrides?.files === undefined) merged.changes.files = summariesFrom(scoped);
    if (changeOverrides?.counts === undefined) {
      merged.changes.counts = countsFrom(scoped, merged.changes.files);
    }
  }

  return merged;
}
