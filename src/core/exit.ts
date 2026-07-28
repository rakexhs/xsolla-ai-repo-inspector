/**
 * The single mapping from a review result to a process exit code.
 *
 * Kept in its own module so that `errors.ts` (which owns the code taxonomy)
 * and `types.ts` (which owns the result shape) do not have to import each
 * other.
 */
import { EXIT_CODES, exitCodeForDiagnostic, type ExitCode } from "./errors.js";
import type { ReviewResult } from "./types.js";

/**
 * Precedence: a fatal diagnostic decides the code, otherwise a failed
 * validation yields 1, otherwise 0.
 *
 * The 1-vs-3 distinction is the one that matters in CI: 1 means "the tool
 * worked and your code is failing", 3 means "the tool could not inspect
 * anything". The starter conflated both with 0 in several paths.
 */
export function exitCodeForResult(result: ReviewResult): ExitCode {
  const fatal = result.diagnostics.find((d) => d.severity === "fatal");
  if (fatal) return exitCodeForDiagnostic(fatal.code);

  const timedOut = result.validations.some((v) => v.status === "timed_out");
  if (timedOut) return EXIT_CODES.TIMEOUT;

  if (result.validations.some((v) => v.status !== "passed")) {
    return EXIT_CODES.VALIDATION_FAILED;
  }

  return result.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION_FAILED;
}
