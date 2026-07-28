/**
 * Closed diagnostic taxonomy and the single mapping from a review outcome to a
 * process exit code.
 *
 * The core engine does not throw for expected failures. A repository that is
 * not a Git work tree, a base ref that does not resolve, a validation command
 * that fails or times out — all of these are *data*, reported as diagnostics on
 * a well-formed result. Throwing is reserved for programmer errors, which
 * surface as E_INTERNAL.
 */

/** Fatal codes prevent a meaningful review from being produced. */
export const FATAL_CODES = [
  "E_ARGS",
  "E_NOT_A_REPO",
  "E_BASE_REF_UNKNOWN",
  "E_NO_MERGE_BASE",
  "E_GIT_FAILED",
  "E_GIT_TIMEOUT",
  "E_PATH_OUTSIDE_ROOT",
  "E_CONFIG_INVALID",
  "E_VALIDATION_UNKNOWN",
  "E_INTERNAL",
] as const;

/** Non-fatal codes annotate a result that is still usable. */
export const NON_FATAL_CODES = [
  "E_VALIDATION_DENIED",
  "E_VALIDATION_TIMEOUT",
  "E_VALIDATION_SPAWN",
  "E_VALIDATION_FAILED",
  "W_NO_COMMITS",
  "W_NO_BASE_REF",
  "W_DETACHED_HEAD",
  "W_UNMERGED_PATHS",
  "W_SUBMODULE_UNINSPECTED",
  "W_TRUNCATED",
  "W_REPO_CONFIG_IGNORED",
] as const;

export const DIAGNOSTIC_CODES = [...FATAL_CODES, ...NON_FATAL_CODES] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticSeverity = "fatal" | "error" | "warning";

export type Diagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Exactly one human-readable line. Never a serialised Error object. */
  message: string;
  /** Optional actionable next step. */
  hint?: string;
};

/**
 * Process exit codes.
 *
 * The distinction between 1 and 3 is the important one: 1 means "the tool
 * worked and your code is failing", 3 means "the tool could not inspect
 * anything". CI needs to tell those apart.
 */
export const EXIT_CODES = {
  /** Review completed; nothing failed. */
  OK: 0,
  /** Review completed; at least one validation failed. */
  VALIDATION_FAILED: 1,
  /** The caller invoked the tool incorrectly. */
  USAGE: 2,
  /** The repository could not be inspected. */
  INSPECTION_FAILED: 3,
  /** A time budget was exceeded. */
  TIMEOUT: 4,
  /** Unexpected internal error (sysexits EX_SOFTWARE). */
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const FATAL_SET: ReadonlySet<string> = new Set(FATAL_CODES);

export function isFatalCode(code: DiagnosticCode): boolean {
  return FATAL_SET.has(code);
}

/** Maps a single fatal diagnostic code to the exit code it implies. */
export function exitCodeForDiagnostic(code: DiagnosticCode): ExitCode {
  switch (code) {
    case "E_ARGS":
    case "E_CONFIG_INVALID":
    case "E_VALIDATION_UNKNOWN":
      return EXIT_CODES.USAGE;
    case "E_GIT_TIMEOUT":
      return EXIT_CODES.TIMEOUT;
    case "E_NOT_A_REPO":
    case "E_BASE_REF_UNKNOWN":
    case "E_NO_MERGE_BASE":
    case "E_GIT_FAILED":
    case "E_PATH_OUTSIDE_ROOT":
      return EXIT_CODES.INSPECTION_FAILED;
    case "E_INTERNAL":
      return EXIT_CODES.INTERNAL;
    default:
      return EXIT_CODES.VALIDATION_FAILED;
  }
}

/**
 * Thrown only across internal boundaries where a return value cannot carry the
 * failure (for example config loading, before a result object exists). The CLI
 * and MCP adapters convert it into a diagnostic; it never escapes to a user as
 * a stack trace unless --debug is set.
 */
export class InspectorError extends Error {
  readonly code: DiagnosticCode;
  /**
   * Explicitly `string | undefined` rather than optional: under
   * `exactOptionalPropertyTypes` an optional property cannot be assigned
   * `undefined`, and a class field must be definitely assigned.
   */
  readonly hint: string | undefined;

  constructor(code: DiagnosticCode, message: string, hint?: string) {
    super(message);
    this.name = "InspectorError";
    this.code = code;
    this.hint = hint;
  }

  toDiagnostic(): Diagnostic {
    const diagnostic: Diagnostic = {
      code: this.code,
      severity: isFatalCode(this.code) ? "fatal" : "error",
      message: this.message,
    };
    if (this.hint !== undefined) diagnostic.hint = this.hint;
    return diagnostic;
  }
}

/**
 * Reduces an unknown thrown value to a single readable line.
 *
 * This is what prevents the starter's behaviour of dumping a Node error object
 * containing a circular reference to the terminal.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
