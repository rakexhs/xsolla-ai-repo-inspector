/**
 * Validation execution.
 *
 * Two properties define this module.
 *
 * **It never throws for an expected failure.** A command that exits non-zero,
 * times out, or cannot be spawned is *data* on a `ValidationOutcome`. The
 * starter used `exec` and rejected its promise on any non-zero exit, so the
 * first failing test suite aborted the entire review — destroying exactly the
 * information the user came for. Reporting the failure *is* the product, so a
 * failing validation must never prevent the next one from running.
 *
 * **It never uses a shell.** `spawn` is always called with an argv array and
 * `shell: false`, so there is no string that could be re-parsed and no
 * injection surface between the allowlist and the kernel.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Diagnostic } from "../core/errors.js";
import { describeError } from "../core/errors.js";
import type {
  DeniedValidation,
  Limits,
  PlannedValidation,
  ValidationOutcome,
  ValidationStatus,
} from "../core/types.js";
import { clampText, sanitizeOutput } from "../core/text.js";

export type RunOptions = {
  validations: PlannedValidation[];
  denied: DeniedValidation[];
  cwd: string;
  limits: Limits;
};

export type RunOutcome = {
  outcomes: ValidationOutcome[];
  diagnostics: Diagnostic[];
};

/** Grace between SIGTERM and SIGKILL for a process group that will not leave. */
const KILL_GRACE_MS = 2_000;

/**
 * How long to wait for stdout/stderr to end *after* the child has exited.
 *
 * A child that spawned a grandchild sharing its stdout leaves the pipe open
 * after it exits. Waiting on stream end alone would hang until the grandchild
 * dies, so the exit event is authoritative and this is only a flush window.
 */
const STDIO_FLUSH_GRACE_MS = 500;

/**
 * Environment variables passed through to a validation.
 *
 * Everything else is dropped. An LLM chooses *which* allowlisted command runs,
 * so the blast radius of a bad choice must not include the operator's secrets:
 * `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, `OPENAI_API_KEY` and
 * friends never reach the child, and therefore cannot be exfiltrated by a
 * command that prints its environment or by a compromised dev dependency.
 */
const ENV_PASSTHROUGH = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

/**
 * Forced into the child's environment. `CI=1` makes interactive tools take
 * their non-interactive path; the colour variables stop tools emitting ANSI
 * that would be stripped anyway and, in the MCP case, waste context window.
 */
const ENV_FORCED: Readonly<Record<string, string>> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
};

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ENV_FORCED };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Accumulates a stream up to a byte cap while continuing to consume everything
 * beyond it.
 *
 * The subtlety that matters: we must keep *reading* after the cap is reached.
 * Pausing the stream (or removing the listener) fills the OS pipe buffer, the
 * child blocks forever on its next write, and an output-size problem silently
 * becomes a hang that only the timeout can resolve. So the excess is read and
 * thrown away, and only the count is kept.
 */
class CappedStream {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private discarded = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.kept;
    if (room <= 0) {
      this.discarded += chunk.length;
      return;
    }
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, room));
    this.kept += room;
    this.discarded += chunk.length - room;
  }

  get discardedBytes(): number {
    return this.discarded;
  }

  text(): string {
    const bytes = Buffer.concat(this.chunks);
    const decoder = new StringDecoder("utf8");
    // If the cap split the final UTF-8 sequence, keep it buffered instead of
    // inventing a replacement character. Complete streams retain normal Node
    // decoding behavior for genuinely invalid bytes.
    return this.discarded > 0 ? decoder.write(bytes) : decoder.end(bytes);
  }
}

type Finalised = { text: string; truncated: boolean; droppedBytes: number };

/** Sanitises, then clamps, and reports whether anything was lost at any stage. */
function finalise(stream: CappedStream, limits: Limits): Finalised {
  const raw = stream.text();
  const sanitized = sanitizeOutput(raw);
  const clamped = clampText(sanitized, {
    maxBytes: limits.maxOutputBytesPerStream,
    maxLines: limits.maxOutputLinesPerStream,
  });
  return {
    text: clamped.text,
    // Bytes dropped at the pipe cap count as truncation even when whatever we
    // kept fits comfortably inside the clamp budget.
    truncated: clamped.truncated || stream.discardedBytes > 0,
    droppedBytes:
      clamped.droppedBytes +
      stream.discardedBytes +
      Math.max(0, Buffer.byteLength(raw, "utf8") - Buffer.byteLength(sanitized, "utf8")),
  };
}

/**
 * Signals an entire process group, tolerating a group that has already gone.
 *
 * `child.kill()` signals only the direct child. `npm test` immediately execs a
 * test runner as a grandchild; killing npm leaves the runner alive, still
 * holding ports and CPU, reparented to init. Inside a long-running MCP server
 * those orphans accumulate for the lifetime of the session. Spawning with
 * `detached: true` makes the child a process-group leader so `-pid` addresses
 * the whole tree it created.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // Negative pid = "every process in this group". Note the inherent race:
    // between the child exiting and this call the group may empty and its id
    // become reusable. The window is sub-millisecond and unavoidable for any
    // group-based cleanup; killing the tree is worth it.
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the outcome we wanted.
    // EPERM / EINVAL (and Windows, which has no process groups): fall back to
    // the direct child so at least it does not survive.
    try {
      child.kill(signal);
    } catch {
      // Nothing further is possible, and cleanup must never break the run.
    }
  }
}

function outcomeFor(
  planned: PlannedValidation,
  status: ValidationStatus,
  fields: {
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    stdout: Finalised;
    stderr: Finalised;
    reason?: string;
  },
): ValidationOutcome {
  const outcome: ValidationOutcome = {
    id: planned.id,
    argv: [...planned.argv],
    status,
    exitCode: fields.exitCode,
    signal: fields.signal,
    durationMs: fields.durationMs,
    stdout: fields.stdout.text,
    stderr: fields.stderr.text,
    truncated: { stdout: fields.stdout.truncated, stderr: fields.stderr.truncated },
  };
  if (fields.stdout.droppedBytes > 0 || fields.stderr.droppedBytes > 0) {
    outcome.outputBytesDropped = {
      stdout: fields.stdout.droppedBytes,
      stderr: fields.stderr.droppedBytes,
    };
  }
  // exactOptionalPropertyTypes: an absent reason must be an absent key.
  if (fields.reason !== undefined) outcome.reason = fields.reason;
  return outcome;
}

function deniedOutcome(entry: DeniedValidation, argv: string[]): ValidationOutcome {
  return {
    id: entry.id,
    argv,
    status: "denied",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    reason: entry.reason,
  };
}

const EMPTY_FINALISED: Finalised = { text: "", truncated: false, droppedBytes: 0 };

type SingleRun = { outcome: ValidationOutcome; diagnostics: Diagnostic[] };

/** Runs one command. Resolves for every outcome; never rejects. */
async function runOne(
  planned: PlannedValidation,
  cwd: string,
  limits: Limits,
): Promise<SingleRun> {
  const started = Date.now();
  const program = planned.argv[0];

  if (program === undefined || program.length === 0) {
    const reason = "no program to run: argv is empty";
    return {
      outcome: outcomeFor(planned, "spawn_error", {
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: EMPTY_FINALISED,
        stderr: EMPTY_FINALISED,
        reason,
      }),
      diagnostics: [
        {
          code: "E_VALIDATION_SPAWN",
          severity: "error",
          message: `validation ${JSON.stringify(planned.id)} could not be started: ${reason}`,
        },
      ],
    };
  }

  const stdout = new CappedStream(limits.maxOutputBytesPerStream);
  const stderr = new CappedStream(limits.maxOutputBytesPerStream);

  let timedOut = false;
  let spawnError: string | null = null;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawn(program, planned.argv.slice(1), {
    cwd,
    env: buildEnv(),
    // No shell, ever. The argv array reaches execve untouched, so there is no
    // string for anything to re-interpret.
    shell: false,
    // stdin is /dev/null: a command that prompts for input (a password, a
    // "continue? [y/N]") would otherwise block forever on a read that can never
    // be answered, because nobody is attached to this process.
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so a timeout can kill the whole tree (see killGroup).
    detached: true,
    windowsHide: true,
  });

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  // A pipe error (EPIPE on a killed child) must not become an unhandled
  // 'error' event that crashes the host process.
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  const streamsClosed = Promise.all([
    new Promise<void>((resolve) => child.stdout.once("end", () => resolve())),
    new Promise<void>((resolve) => child.stderr.once("end", () => resolve())),
  ]);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", (error) => {
        // ENOENT (command not found), EACCES (not executable), and friends.
        spawnError = describeError(error);
        resolve({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      // Escalate if the tree ignores or is too busy to handle SIGTERM.
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, planned.timeoutMs);

    const result = await exited;

    if (spawnError === null) {
      // The exit event is authoritative; give the pipes a bounded window to
      // flush rather than waiting on a grandchild that may hold them open.
      await Promise.race([
        streamsClosed,
        new Promise<void>((resolve) => {
          const flushTimer = setTimeout(resolve, STDIO_FLUSH_GRACE_MS);
          flushTimer.unref();
        }),
      ]);
    }

    const durationMs = Date.now() - started;
    const finalStdout = finalise(stdout, limits);
    const finalStderr = finalise(stderr, limits);
    const diagnostics: Diagnostic[] = [];

    if (finalStdout.truncated || finalStderr.truncated) {
      const dropped = finalStdout.droppedBytes + finalStderr.droppedBytes;
      diagnostics.push({
        code: "W_TRUNCATED",
        severity: "warning",
        message: `validation ${JSON.stringify(planned.id)}: ${dropped} bytes of output elided`,
      });
    }

    if (spawnError !== null) {
      diagnostics.push({
        code: "E_VALIDATION_SPAWN",
        severity: "error",
        message: `validation ${JSON.stringify(planned.id)} could not be started: ${spawnError}`,
        hint: `Check that ${JSON.stringify(program)} is installed and on PATH.`,
      });
      return {
        outcome: outcomeFor(planned, "spawn_error", {
          exitCode: null,
          signal: null,
          durationMs,
          stdout: finalStdout,
          stderr: finalStderr,
          reason: spawnError,
        }),
        diagnostics,
      };
    }

    if (timedOut) {
      diagnostics.push({
        code: "E_VALIDATION_TIMEOUT",
        severity: "error",
        message: `validation ${JSON.stringify(planned.id)} timed out after ${planned.timeoutMs} ms and was terminated`,
      });
      return {
        outcome: outcomeFor(planned, "timed_out", {
          exitCode: null,
          signal: result.signal ?? "SIGTERM",
          durationMs,
          stdout: finalStdout,
          stderr: finalStderr,
          reason: `exceeded the ${planned.timeoutMs} ms timeout`,
        }),
        diagnostics,
      };
    }

    const passed = result.code === 0;
    if (!passed) {
      diagnostics.push({
        code: "E_VALIDATION_FAILED",
        // Warning severity on purpose: a failing check is a successful
        // *inspection*. The review is complete and correct; the code is not.
        severity: "warning",
        message:
          result.code !== null
            ? `validation ${JSON.stringify(planned.id)} failed with exit code ${result.code}`
            : `validation ${JSON.stringify(planned.id)} was terminated by signal ${result.signal}`,
      });
    }

    return {
      outcome: outcomeFor(planned, passed ? "passed" : "failed", {
        exitCode: result.code,
        signal: result.signal,
        durationMs,
        stdout: finalStdout,
        stderr: finalStderr,
      }),
      diagnostics,
    };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    // Reap the process group even on a clean exit. A command that leaves a
    // daemon or watcher behind would otherwise outlive the review and, in an
    // MCP server, accumulate across a whole session.
    killGroup(child, "SIGTERM");
  }
}

/**
 * Runs every planned validation sequentially and returns one outcome per input.
 *
 * Sequential by design: validations share one working tree, one set of ports
 * and one package cache, so running them concurrently produces flaky,
 * unreproducible failures that are worse than slow ones.
 */
export async function runValidations(options: RunOptions): Promise<RunOutcome> {
  const { validations, denied, cwd, limits } = options;

  const outcomes: ValidationOutcome[] = [];
  const diagnostics: Diagnostic[] = [];
  const budgetStarted = Date.now();

  for (const planned of validations) {
    const elapsed = Date.now() - budgetStarted;
    const remaining = limits.totalValidationBudgetMs - elapsed;
    if (remaining <= 0) {
      // Recorded, not dropped: the caller must be able to tell "this did not
      // run" from "this passed".
      const reason = "total validation time budget exhausted";
      outcomes.push(deniedOutcome({ id: planned.id, reason }, [...planned.argv]));
      diagnostics.push({
        code: "E_VALIDATION_DENIED",
        severity: "warning",
        message: `validation ${JSON.stringify(planned.id)} did not run: ${reason} (${limits.totalValidationBudgetMs} ms)`,
      });
      continue;
    }

    // A failure here is data, so the loop always continues to the next entry.
    // The total budget is a deadline, not merely a gate between commands.
    // Constrain the command currently starting so the first command cannot
    // overrun the advertised total by an arbitrary amount.
    const effective: PlannedValidation = {
      ...planned,
      timeoutMs: Math.max(1, Math.min(planned.timeoutMs, remaining)),
    };
    const result = await runOne(effective, cwd, limits);
    outcomes.push(result.outcome);
    diagnostics.push(...result.diagnostics);
  }

  for (const entry of denied) {
    outcomes.push(deniedOutcome(entry, []));
    diagnostics.push({
      code: "E_VALIDATION_DENIED",
      severity: "warning",
      message: `validation ${JSON.stringify(entry.id)} was not run: ${entry.reason}`,
    });
  }

  return { outcomes, diagnostics };
}
