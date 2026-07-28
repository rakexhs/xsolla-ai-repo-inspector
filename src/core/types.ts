/**
 * The single source of truth for the review contract.
 *
 * Every shape is declared once as a Zod schema and the TypeScript types are
 * inferred from it. The CLI's `--format json` output, the MCP tool's
 * `structuredContent`, and the MCP tool's advertised `outputSchema` are all
 * derived from these same declarations, so the two interfaces cannot drift
 * apart by construction.
 */
import { z } from "zod";
import { DIAGNOSTIC_CODES } from "./errors.js";

/** Bumped only on a breaking change to the result shape. */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Change scopes
// ---------------------------------------------------------------------------

/**
 * The four disjoint places a change can live.
 *
 * The starter reported only `committed`, which is silently wrong for the most
 * common AI-agent case: an agent that has just edited files and not committed
 * them. Keeping the scopes disjoint (rather than merging into one lossy list)
 * lets a consumer ask "what did I not commit yet?" and "what landed on this
 * branch?" separately.
 */
export const SCOPES = ["committed", "staged", "unstaged", "untracked"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typechange",
  "untracked",
  "unmerged",
] as const;
export const FileStatusSchema = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const ChangedFileSchema = z.object({
  /** Always repository-relative, never absolute. */
  path: z.string(),
  status: FileStatusSchema,
  /**
   * Present only for Git's opaque directory marker (notably an embedded
   * repository). Ordinary entries are files and omit this field.
   */
  kind: z.literal("directory").optional(),
  /** Previous path for renames and copies. */
  origPath: z.string().optional(),
  /** Git similarity score for renames/copies, 0-100. */
  score: z.number().int().min(0).max(100).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** One row per distinct path, unioned across every scope it appears in. */
export const FileSummarySchema = z.object({
  path: z.string(),
  kind: z.literal("directory").optional(),
  /** Most worktree-proximate status, per STATUS_PRECEDENCE. */
  status: FileStatusSchema,
  scopes: z.array(ScopeSchema),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const ChangeCountsSchema = z.object({
  committed: z.number().int().min(0),
  staged: z.number().int().min(0),
  unstaged: z.number().int().min(0),
  untracked: z.number().int().min(0),
  /** Distinct paths across all scopes. */
  distinctFiles: z.number().int().min(0),
});
export type ChangeCounts = z.infer<typeof ChangeCountsSchema>;

export const ChangeSetSchema = z.object({
  committed: z.array(ChangedFileSchema),
  staged: z.array(ChangedFileSchema),
  unstaged: z.array(ChangedFileSchema),
  untracked: z.array(ChangedFileSchema),
  files: z.array(FileSummarySchema),
  counts: ChangeCountsSchema,
  /** True when a per-scope file cap elided entries. */
  listTruncated: z.boolean(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/**
 * Which status wins when a path appears in several scopes.
 *
 * Worktree reality beats history: if a file is committed-modified but
 * unstaged-deleted, the useful answer for an agent is "deleted".
 */
export const STATUS_PRECEDENCE: readonly FileStatus[] = [
  "unmerged",
  "deleted",
  "untracked",
  "renamed",
  "copied",
  "added",
  "typechange",
  "modified",
];

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const HeadInfoSchema = z.object({
  /** No commits yet (freshly `git init`ed). */
  unborn: z.boolean(),
  detached: z.boolean(),
  sha: z.string().nullable(),
  branch: z.string().nullable(),
});
export type HeadInfo = z.infer<typeof HeadInfoSchema>;

export const ResolvedBaseSchema = z.object({
  /** What the caller asked for, or null when auto-detected. */
  requested: z.string().nullable(),
  /** The ref that actually resolved. */
  ref: z.string(),
  sha: z.string(),
  /** merge-base(base, HEAD) — the commit the committed diff is taken against. */
  mergeBase: z.string(),
  autoDetected: z.boolean(),
});
export type ResolvedBase = z.infer<typeof ResolvedBaseSchema>;

export const RepositoryInfoSchema = z.object({
  /** Absolute, canonical path. Appears exactly once in a result. */
  path: z.string(),
  head: HeadInfoSchema,
  base: ResolvedBaseSchema.nullable(),
});
export type RepositoryInfo = z.infer<typeof RepositoryInfoSchema>;

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

export const VALIDATION_STATUSES = [
  "passed",
  "failed",
  "timed_out",
  "spawn_error",
  "denied",
] as const;
export const ValidationStatusSchema = z.enum(VALIDATION_STATUSES);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const ValidationOutcomeSchema = z.object({
  /** Stable identifier: an allowlist key, or `argv:<n>` for CLI ad-hoc runs. */
  id: z.string(),
  /** Exactly what was executed. No shell, so this is the whole truth. */
  argv: z.array(z.string()),
  status: ValidationStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().min(0),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  /** Exact captured-output bytes removed before the whole-result budget pass. */
  outputBytesDropped: z
    .object({ stdout: z.number().int().min(0), stderr: z.number().int().min(0) })
    .optional(),
  /** Present for denied and spawn_error outcomes. */
  reason: z.string().optional(),
});
export type ValidationOutcome = z.infer<typeof ValidationOutcomeSchema>;

/** A validation the trust layer has already authorised and resolved to argv. */
export type PlannedValidation = {
  id: string;
  argv: string[];
  timeoutMs: number;
};

/** A validation the trust layer refused, recorded so the caller learns why. */
export type DeniedValidation = {
  id: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// Diagnostics and truncation
// ---------------------------------------------------------------------------

export const DiagnosticSchema = z.object({
  code: z.enum(DIAGNOSTIC_CODES),
  severity: z.enum(["fatal", "error", "warning"]),
  message: z.string(),
  hint: z.string().optional(),
});

/**
 * Truncation is always self-declaring.
 *
 * `fields` names every field shortened anywhere in the pipeline. `droppedBytes`
 * is the sum of bytes removed by per-stream capture/clamping and by the final
 * whole-result budget pass.
 */
export const TruncationInfoSchema = z.object({
  applied: z.boolean(),
  droppedBytes: z.number().int().min(0),
  /** Dotted paths of fields that were shortened, sorted. */
  fields: z.array(z.string()),
});
export type TruncationInfo = z.infer<typeof TruncationInfoSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const DETAIL_LEVELS = ["summary", "full"] as const;
export const DetailLevelSchema = z.enum(DETAIL_LEVELS);
export type DetailLevel = z.infer<typeof DetailLevelSchema>;

/**
 * The complete review result.
 *
 * Deliberately contains no timestamps and no absolute paths other than
 * `repository.path`, so that two runs over the same repository state produce
 * byte-identical output apart from measured durations. That determinism is
 * what makes the CLI/MCP consistency test meaningful.
 */
export const ReviewResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** No fatal diagnostic AND every executed validation passed. */
  ok: z.boolean(),
  detail: DetailLevelSchema,
  scopes: z.array(ScopeSchema),
  repository: RepositoryInfoSchema,
  changes: ChangeSetSchema,
  validations: z.array(ValidationOutcomeSchema),
  diagnostics: z.array(DiagnosticSchema),
  truncation: TruncationInfoSchema,
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Raw shape form, required by the MCP SDK's `outputSchema`. */
export const REVIEW_RESULT_SHAPE = ReviewResultSchema.shape;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LimitsSchema = z.object({
  /** Per stream (stdout/stderr) of a single validation. */
  maxOutputBytesPerStream: z.number().int().positive(),
  maxOutputLinesPerStream: z.number().int().positive(),
  /** Whole-document cap applied after per-item caps. */
  maxTotalBytes: z.number().int().positive(),
  /** Paths listed per scope before eliding. */
  maxFilesPerScope: z.number().int().positive(),
  gitTimeoutMs: z.number().int().positive(),
  validationTimeoutMs: z.number().int().positive(),
  /** Wall-clock budget across all validations combined. */
  totalValidationBudgetMs: z.number().int().positive(),
});
export type Limits = z.infer<typeof LimitsSchema>;

/**
 * CLI defaults: a human or CI job reading a file, so budgets are generous.
 */
export const CLI_LIMITS: Limits = {
  maxOutputBytesPerStream: 32 * 1024,
  maxOutputLinesPerStream: 2000,
  maxTotalBytes: 256 * 1024,
  maxFilesPerScope: 1000,
  gitTimeoutMs: 10_000,
  validationTimeoutMs: 120_000,
  totalValidationBudgetMs: 300_000,
};

/**
 * MCP defaults: output lands directly in a model's context window, so the
 * budgets are an order of magnitude tighter and the timeouts shorter.
 * This divergence is deliberate, documented, and asserted by a test.
 */
export const MCP_LIMITS: Limits = {
  maxOutputBytesPerStream: 4 * 1024,
  maxOutputLinesPerStream: 200,
  maxTotalBytes: 16 * 1024,
  maxFilesPerScope: 50,
  gitTimeoutMs: 10_000,
  validationTimeoutMs: 60_000,
  totalValidationBudgetMs: 120_000,
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * A fully-resolved review request.
 *
 * By the time this reaches the core engine every trust decision has already
 * been made: `validations` are authorised argv arrays and `denied` records what
 * was refused. The core never decides what is allowed to run.
 */
export type ReviewRequest = {
  /** Absolute, already canonicalised and confinement-checked. */
  repositoryPath: string;
  baseRef?: string;
  scopes: Scope[];
  detail: DetailLevel;
  validations: PlannedValidation[];
  denied: DeniedValidation[];
  limits: Limits;
  /**
   * Trust the inspected repository's own git configuration, including keys git
   * executes. Absent or false means repository-scoped executable keys are
   * disabled for the duration of the inspection.
   *
   * Like every other field here, this is a decision already taken by an
   * adapter: the CLI can set it from `--allow-repo-exec-config`, and the MCP
   * adapter has no path to set it at all.
   */
  allowRepoExecConfig?: boolean;
};
