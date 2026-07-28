import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidations } from "../../src/validation/run.js";
import type { Limits, PlannedValidation } from "../../src/core/types.js";

/**
 * Every command is `process.execPath` plus a fixture script, so the suite
 * depends on nothing but the Node binary already running it.
 */
const FIXTURES = fileURLToPath(new URL("../helpers/fixtures/", import.meta.url));
const NODE = process.execPath;

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

const LIMITS: Limits = {
  maxOutputBytesPerStream: 4 * 1024,
  maxOutputLinesPerStream: 200,
  maxTotalBytes: 64 * 1024,
  maxFilesPerScope: 50,
  gitTimeoutMs: 10_000,
  validationTimeoutMs: 30_000,
  totalValidationBudgetMs: 300_000,
};

function plan(
  id: string,
  args: string[],
  timeoutMs = 30_000,
): PlannedValidation {
  return { id, argv: [NODE, ...args], timeoutMs };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "inspector-run-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function run(validations: PlannedValidation[], overrides: Partial<Limits> = {}) {
  return runValidations({
    validations,
    denied: [],
    cwd: workDir,
    limits: { ...LIMITS, ...overrides },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True once `pid` no longer exists. Polls, because reaping is not instant. */
async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

async function readPidFile(file: string, timeoutMs = 10_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(file, "utf8");
      if (raw.length > 0) return JSON.parse(raw);
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) throw new Error(`pid file never appeared: ${file}`);
    await sleep(50);
  }
}

describe("runValidations — exit statuses", () => {
  it("records a zero exit as passed", async () => {
    const { outcomes, diagnostics } = await run([plan("ok", [fixture("exit-with.mjs"), "0"])]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("passed");
    expect(outcomes[0]?.exitCode).toBe(0);
    expect(outcomes[0]?.signal).toBeNull();
    expect(outcomes[0]?.stdout).toContain("stdout line");
    expect(outcomes[0]?.stderr).toContain("stderr line");
    expect(outcomes[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // THE headline regression. The starter used `exec` and rejected its promise
  // on a non-zero exit, so the first failing suite aborted the whole review --
  // discarding precisely the information the user asked for. A failure must be
  // data, and the queue must keep moving.
  // -----------------------------------------------------------------------
  it("records a non-zero exit as failed AND still runs every later validation", async () => {
    const { outcomes, diagnostics } = await run([
      plan("first-fails", [fixture("exit-with.mjs"), "1", "first"]),
      plan("second-runs", [fixture("exit-with.mjs"), "0", "second"]),
      plan("third-runs", [fixture("exit-with.mjs"), "3", "third"]),
    ]);

    expect(outcomes.map((outcome) => outcome.id)).toEqual([
      "first-fails",
      "second-runs",
      "third-runs",
    ]);

    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.exitCode).toBe(1);
    expect(outcomes[0]?.stdout).toContain("first: stdout line");

    // The proof that execution was not aborted: the later commands really ran.
    expect(outcomes[1]?.status).toBe("passed");
    expect(outcomes[1]?.exitCode).toBe(0);
    expect(outcomes[1]?.stdout).toContain("second: stdout line");

    expect(outcomes[2]?.status).toBe("failed");
    expect(outcomes[2]?.exitCode).toBe(3);
    expect(outcomes[2]?.stdout).toContain("third: stdout line");

    const failures = diagnostics.filter((d) => d.code === "E_VALIDATION_FAILED");
    expect(failures).toHaveLength(2);
    expect(failures.every((d) => d.severity === "warning")).toBe(true);
  });

  it("reports a missing binary as spawn_error instead of throwing", async () => {
    const { outcomes, diagnostics } = await runValidations({
      validations: [
        { id: "missing", argv: ["definitely-not-a-real-binary-xyz123"], timeoutMs: 10_000 },
      ],
      denied: [],
      cwd: workDir,
      limits: LIMITS,
    });

    expect(outcomes[0]?.status).toBe("spawn_error");
    expect(outcomes[0]?.exitCode).toBeNull();
    expect(outcomes[0]?.reason).toContain("ENOENT");
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_SPAWN");
  });

  it("reports an empty argv as spawn_error rather than crashing", async () => {
    const { outcomes } = await runValidations({
      validations: [{ id: "empty", argv: [], timeoutMs: 1_000 }],
      denied: [],
      cwd: workDir,
      limits: LIMITS,
    });
    expect(outcomes[0]?.status).toBe("spawn_error");
  });

  it("returns outcomes in the same order as the planned input", async () => {
    const ids = ["a", "b", "c", "d"];
    const { outcomes } = await run(
      ids.map((id) => plan(id, [fixture("exit-with.mjs"), "0", id])),
    );
    expect(outcomes.map((outcome) => outcome.id)).toEqual(ids);
    for (const [index, id] of ids.entries()) {
      expect(outcomes[index]?.stdout).toContain(`${id}: stdout line`);
    }
  });
});

describe("runValidations — timeouts and process-tree cleanup", () => {
  it("times out a hanging command and actually kills the process", async () => {
    const pidFile = path.join(workDir, "sleeper.pid");
    const started = Date.now();

    const { outcomes, diagnostics } = await run([
      plan("hang", [fixture("sleep-forever.mjs"), pidFile], 1_500),
    ]);

    expect(outcomes[0]?.status).toBe("timed_out");
    expect(outcomes[0]?.exitCode).toBeNull();
    expect(outcomes[0]?.signal).not.toBeNull();
    expect(outcomes[0]?.durationMs).toBeGreaterThanOrEqual(1_400);
    // 1.5s timeout + at most a 2s SIGKILL grace, well clear of this bound.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_TIMEOUT");

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  // `child.kill()` signals only the direct child. `npm test` execs a test
  // runner as a grandchild that would survive, hold ports, and -- inside a
  // long-lived MCP server -- accumulate for the whole session.
  it("kills a grandchild too when the child hangs (process-group kill)", async () => {
    const pidFile = path.join(workDir, "tree-hang.json");

    const runPromise = run([
      plan("tree", [fixture("spawn-grandchild.mjs"), pidFile, "hang"], 1_500),
    ]);
    const pids = (await readPidFile(pidFile)) as { child: number; grandchild: number };
    const { outcomes } = await runPromise;

    expect(outcomes[0]?.status).toBe("timed_out");
    expect(await waitUntilDead(pids.child)).toBe(true);
    expect(await waitUntilDead(pids.grandchild)).toBe(true);
  });

  it("kills a leftover grandchild even when the child exits cleanly", async () => {
    const pidFile = path.join(workDir, "tree-exit.json");

    const { outcomes } = await run([
      plan("tree-exit", [fixture("spawn-grandchild.mjs"), pidFile, "exit"], 10_000),
    ]);

    expect(outcomes[0]?.status).toBe("passed");
    const pids = (await readPidFile(pidFile)) as { child: number; grandchild: number };
    // A validation must not leave a daemon running after the review is done.
    expect(await waitUntilDead(pids.grandchild)).toBe(true);
  });

  it("times out the active command and denies the remainder at the total deadline", async () => {
    const { outcomes, diagnostics } = await run(
      [
        plan("slow", [fixture("sleep-ms.mjs"), "600"]),
        plan("skipped", [fixture("exit-with.mjs"), "0", "skipped"]),
      ],
      { totalValidationBudgetMs: 300 },
    );

    expect(outcomes[0]?.status).toBe("timed_out");
    // Recorded, not silently dropped: "did not run" must be distinguishable
    // from "passed".
    expect(outcomes[1]?.status).toBe("denied");
    expect(outcomes[1]?.reason).toContain("budget exhausted");
    expect(outcomes[1]?.exitCode).toBeNull();
    expect(outcomes[1]?.durationMs).toBe(0);
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_TIMEOUT");
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_DENIED");
  });
});

describe("runValidations — output handling", () => {
  it("truncates ~10 MB of output and still finishes promptly", async () => {
    const started = Date.now();
    const { outcomes, diagnostics } = await run([
      plan("flood", [fixture("big-output.mjs"), "10"], 30_000),
    ]);
    const elapsed = Date.now() - started;

    expect(outcomes[0]?.status).toBe("passed");
    expect(outcomes[0]?.truncated.stdout).toBe(true);
    expect(outcomes[0]?.outputBytesDropped?.stdout).toBeGreaterThan(
      9 * 1024 * 1024,
    );
    expect(Buffer.byteLength(outcomes[0]?.stdout ?? "", "utf8")).toBeLessThanOrEqual(
      LIMITS.maxOutputBytesPerStream,
    );
    // The real assertion: had we stopped reading at the cap, the child would
    // have blocked on a full pipe and this would only end at the 30s timeout.
    expect(elapsed).toBeLessThan(15_000);
    expect(diagnostics.map((d) => d.code)).toContain("W_TRUNCATED");
  });

  it("strips ANSI escapes from stored output", async () => {
    const { outcomes } = await run([plan("ansi", [fixture("ansi-output.mjs")])]);

    const esc = String.fromCharCode(27);
    expect(outcomes[0]?.stdout).toContain("RED-TEXT");
    expect(outcomes[0]?.stdout).toContain("GREEN-BOLD");
    expect(outcomes[0]?.stdout).not.toContain(esc);
    expect(outcomes[0]?.stdout).not.toContain("[31m");
    expect(outcomes[0]?.stderr).toContain("YELLOW-ERR");
    expect(outcomes[0]?.stderr).not.toContain(esc);
  });

  it("does not hang on a command that reads stdin", async () => {
    const started = Date.now();
    const { outcomes } = await run([plan("stdin", [fixture("read-stdin.mjs")], 8_000)]);

    expect(outcomes[0]?.status).toBe("passed");
    expect(outcomes[0]?.stdout).toContain("STDIN-BYTES=0");
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});

describe("runValidations — environment scrubbing", () => {
  it("does not leak the parent's secrets into a child", async () => {
    const secret = "s3cr3t-value-that-must-not-appear-abc123";
    process.env["SECRET_TOKEN"] = secret;
    process.env["GITHUB_TOKEN"] = `gh-${secret}`;
    process.env["AWS_SECRET_ACCESS_KEY"] = `aws-${secret}`;

    try {
      const { outcomes } = await run([
        plan("env", [
          fixture("print-env.mjs"),
          "SECRET_TOKEN",
          "GITHUB_TOKEN",
          "AWS_SECRET_ACCESS_KEY",
          "PATH",
          "CI",
          "NO_COLOR",
          "TERM",
        ]),
      ]);

      const stdout = outcomes[0]?.stdout ?? "";
      expect(outcomes[0]?.status).toBe("passed");
      expect(stdout).not.toContain(secret);
      expect(stdout).toContain("SECRET_TOKEN=<unset>");
      expect(stdout).toContain("GITHUB_TOKEN=<unset>");
      expect(stdout).toContain("AWS_SECRET_ACCESS_KEY=<unset>");
      // The allowlisted variables must still be there or nothing would run.
      expect(stdout).not.toContain("PATH=<unset>");
      expect(stdout).toContain("CI=1");
      expect(stdout).toContain("NO_COLOR=1");
      expect(stdout).toContain("TERM=dumb");
    } finally {
      delete process.env["SECRET_TOKEN"];
      delete process.env["GITHUB_TOKEN"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
    }
  });
});

describe("runValidations — denied entries", () => {
  it("surfaces every denied input as a denied outcome", async () => {
    const { outcomes, diagnostics } = await runValidations({
      validations: [plan("ran", [fixture("exit-with.mjs"), "0", "ran"])],
      denied: [
        { id: "deploy", reason: "not exposed on this interface" },
        { id: "argv:0", reason: "ad-hoc validation commands are disabled" },
      ],
      cwd: workDir,
      limits: LIMITS,
    });

    // Everything the caller asked for is accounted for, nothing is dropped.
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]?.status).toBe("passed");

    const deploy = outcomes.find((outcome) => outcome.id === "deploy");
    expect(deploy?.status).toBe("denied");
    expect(deploy?.exitCode).toBeNull();
    expect(deploy?.signal).toBeNull();
    expect(deploy?.durationMs).toBe(0);
    expect(deploy?.stdout).toBe("");
    expect(deploy?.stderr).toBe("");
    expect(deploy?.truncated).toEqual({ stdout: false, stderr: false });
    expect(deploy?.reason).toBe("not exposed on this interface");

    expect(diagnostics.filter((d) => d.code === "E_VALIDATION_DENIED")).toHaveLength(2);
  });

  it("returns an empty result for an empty request", async () => {
    const { outcomes, diagnostics } = await runValidations({
      validations: [],
      denied: [],
      cwd: workDir,
      limits: LIMITS,
    });
    expect(outcomes).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
