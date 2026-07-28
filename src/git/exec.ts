/**
 * The single place a Git subprocess is spawned.
 *
 * Three properties matter more than anything else here:
 *
 *  1. **No shell, ever.** `execFile` receives an argv array, so a branch name,
 *     a ref, or a path containing spaces, quotes, `;` or `$(...)` is passed
 *     through as one opaque argument. The starter interpolated paths into a
 *     shell string, which both corrupted paths containing spaces and opened a
 *     command-injection hole.
 *
 *  2. **No *argument* injection either.** An argv array stops shell injection
 *     and nothing else. A caller-supplied ref is still parsed by Git's own
 *     option parser, so a "ref" of `--output=/tmp/x` makes `git diff` write an
 *     arbitrary file. Reproduced against the starter's exact call shape, with
 *     no shell anywhere:
 *
 *         execFileSync("git", ["diff", "--name-status", `${base}...HEAD`])
 *         // base = "--output=/tmp/PWNED2.txt"  ->  creates /tmp/PWNED2.txt...HEAD
 *
 *     Over MCP that is an arbitrary file write chosen by a model. Two
 *     structural defences, both enforced in this module rather than at call
 *     sites: operands are only reachable through {@link runGitRefs}, which
 *     inserts `--end-of-options` ahead of them; and {@link runGit} refuses to
 *     spawn at all if anything after that sentinel could be read as an option.
 *
 *  3. **Failure is a value, not an exception.** Git exiting non-zero is a
 *     completely ordinary event (`rev-parse --verify -q` on a ref that does not
 *     exist is how you *test* for a ref). Callers get a discriminated union and
 *     decide what is fatal.
 */
import { execFile } from "node:child_process";

/** 1 MB (Node's default) reliably ENOBUFSes on a large `--name-status` list. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** A stderr line longer than this is noise, not diagnosis. */
const MAX_STDERR_CHARS = 300;

/**
 * Git's own "everything after this is an operand" sentinel (2.24+).
 *
 * It must appear *after* every real flag and *before* every ref, which is
 * exactly the layout {@link runGitRefs} builds. Verified locally: with the
 * sentinel present, `git diff --end-of-options --output=/tmp/x` fails with
 * "option must come before non-option arguments" and writes nothing.
 */
export const END_OF_OPTIONS = "--end-of-options";

export type GitResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      code: "E_GIT_FAILED" | "E_GIT_TIMEOUT";
      stderr: string;
      exitCode: number | null;
    };

/**
 * Control characters have no business in a ref. Built with explicit \u escapes
 * so this source file stays plain ASCII.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

/**
 * True when `operand` can safely sit in operand position.
 *
 * The leading-dash rule is the load-bearing one and is deliberately applied
 * *in addition* to `--end-of-options`, not instead of it: belt and braces,
 * because a future Git subcommand that does not honour the sentinel would
 * otherwise silently reopen the hole.
 */
export function isSafeGitOperand(operand: string): boolean {
  return (
    operand.length > 0 &&
    !operand.startsWith("-") &&
    !CONTROL_CHARS.test(operand)
  );
}

/**
 * The environment handed to Git.
 *
 * Everything not listed is dropped. Inheriting the caller's full environment
 * means inheriting `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, proxy settings
 * and locale overrides, any of which silently change what we measure.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Byte-oriented, English, unquoted output. Parsing is locale-sensitive
    // otherwise (and `core.quotePath` behaviour differs).
    LANG: "C",
    LC_ALL: "C",
    // No TTY on a server or inside an MCP host: a credential prompt would hang
    // the process indefinitely rather than failing. This is a real hang vector.
    GIT_TERMINAL_PROMPT: "0",
    // Belt to the `--no-optional-locks` braces below. `git status` (and a
    // stat-dirty `git diff`) otherwise rewrites `.git/index` as a refresh
    // optimisation, racing the user's editor and making a supposedly read-only
    // inspection mutate the repository.
    GIT_OPTIONAL_LOCKS: "0",
    // Machine-wide config/attributes must not change what an inspection reports.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
  // `git` needs PATH to find its own helpers; HOME is needed for the user's
  // config to apply (notably `core.autocrlf` and `diff.renames` defaults).
  if (process.env["PATH"] !== undefined) env["PATH"] = process.env["PATH"];
  if (process.env["HOME"] !== undefined) env["HOME"] = process.env["HOME"];
  return env;
}

/** Reduces a stderr blob to one short, safe line for a diagnostic message. */
export function firstStderrLine(stderr: string): string {
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    return line.length > MAX_STDERR_CHARS
      ? `${line.slice(0, MAX_STDERR_CHARS - 1)}…`
      : line;
  }
  return "";
}

type ExecError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  code?: string | number;
};

function refuse(reason: string): GitResult {
  return { ok: false, code: "E_GIT_FAILED", stderr: reason, exitCode: null };
}

/**
 * Central guard: nothing after `--end-of-options` may look like an option.
 *
 * Runs on every single invocation, so a future call site that hand-rolls its
 * argv instead of using {@link runGitRefs} still cannot smuggle an option into
 * operand position.
 */
function checkOperands(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg.includes("\0")) return "refusing git argument containing a NUL byte";
  }
  const sentinel = args.indexOf(END_OF_OPTIONS);
  if (sentinel === -1) return null;
  for (let i = sentinel + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    // `--` is the pathspec terminator and is the one permitted exception.
    if (arg === "--") continue;
    if (!isSafeGitOperand(arg)) {
      return `refusing unsafe git operand: ${JSON.stringify(arg).slice(0, 120)}`;
    }
  }
  return null;
}

/**
 * Runs `git <args>` in `repositoryPath`.
 *
 * Never throws for a Git-level failure; a rejected promise here would be a bug
 * in this function itself.
 */
export function runGit(
  repositoryPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GitResult> {
  const violation = checkOperands(args);
  if (violation !== null) return Promise.resolve(refuse(violation));

  // `--no-optional-locks` is a top-level flag and must precede the subcommand.
  // Applied here, once, so every command in the codebase is read-only: the MCP
  // tool advertises `readOnlyHint: true` and that annotation has to be
  // literally true, not approximately true.
  const argv = ["--no-optional-locks", ...args];

  return new Promise<GitResult>((resolve) => {
    execFile(
      "git",
      argv,
      {
        cwd: repositoryPath,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }

        const execError = error as ExecError;
        // `timeout` makes Node SIGTERM the child; both flags are checked
        // because which one is set depends on how the kill landed.
        const timedOut =
          execError.killed === true || execError.signal === "SIGTERM";

        // `error.code` is the numeric exit status for a normal non-zero exit,
        // and a string like "ENOENT"/"ERR_CHILD_PROCESS_STDIO_MAXBUFFER" when
        // the spawn or the pipe itself failed.
        const exitCode =
          typeof execError.code === "number" ? execError.code : null;

        let line = firstStderrLine(stderr);
        if (line.length === 0) {
          // Never surface a Node error object; reduce it to one line.
          line = timedOut
            ? `git timed out after ${timeoutMs}ms`
            : firstStderrLine(error.message) || "git failed";
        }

        resolve({
          ok: false,
          code: timedOut ? "E_GIT_TIMEOUT" : "E_GIT_FAILED",
          stderr: line,
          exitCode: timedOut ? null : exitCode,
        });
      },
    );
  });
}

export type RefCommandOptions = {
  /**
   * Append `--` after the operands so nothing can be reinterpreted as a
   * pathspec. `diff` accepts it; `merge-base` and `rev-parse` do not, so this
   * is opt-in per subcommand (verified against git 2.50.1).
   */
  pathspecTerminator?: boolean;
};

/**
 * The only sanctioned way to pass ref operands to Git.
 *
 * `flags` is literal text authored in this repository. `refs` is the untrusted
 * part — caller- or model-supplied — and is placed strictly after
 * `--end-of-options`, where {@link runGit}'s guard also inspects it.
 */
export function runGitRefs(
  repositoryPath: string,
  flags: readonly string[],
  refs: readonly string[],
  timeoutMs: number,
  options: RefCommandOptions = {},
): Promise<GitResult> {
  const argv = [...flags, END_OF_OPTIONS, ...refs];
  if (options.pathspecTerminator === true) argv.push("--");
  return runGit(repositoryPath, argv, timeoutMs);
}
