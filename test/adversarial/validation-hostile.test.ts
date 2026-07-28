/**
 * ADVERSARY-1: hostile subprocess behaviour against `src/validation/run.ts`.
 *
 * Every command here is a real process. Nothing is mocked, because the class of
 * bug being hunted (a pipe that fills, a group kill that misses, a timer that
 * silently becomes 1 ms) only exists at the syscall boundary.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runValidations } from "../../src/validation/run.js";
import type { Limits, PlannedValidation } from "../../src/core/types.js";
import { CLI_LIMITS } from "../../src/core/types.js";

const NODE = process.execPath;

const tempDirs: string[] = [];
const strayPids: number[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const restore of envRestores.splice(0)) restore();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inspector-adv-"));
  const real = await fs.realpath(dir);
  tempDirs.push(real);
  return real;
}

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  envRestores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function node(id: string, script: string, timeoutMs = 15_000): PlannedValidation {
  return { id, argv: [NODE, "-e", script], timeoutMs };
}

function limits(overrides: Partial<Limits> = {}): Limits {
  return { ...CLI_LIMITS, ...overrides };
}

async function run(
  validations: PlannedValidation[],
  overrides: Partial<Limits> = {},
  cwd?: string,
) {
  return runValidations({
    validations,
    denied: [],
    cwd: cwd ?? (await tempDir()),
    limits: limits(overrides),
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

describe("hostile process lifecycle", () => {
  it("SIGKILLs a child that ignores SIGTERM", async () => {
    const started = Date.now();
    const { outcomes } = await run([
      node(
        "stubborn",
        "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" +
          "process.stdout.write('up\\n');setInterval(()=>{},1000);",
        500,
      ),
    ]);

    const outcome = outcomes[0];
    expect(outcome?.status).toBe("timed_out");
    // SIGTERM at 500 ms, SIGKILL 2 s later (KILL_GRACE_MS).
    expect(outcome?.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it("kills a same-group grandchild spawned by a double fork", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "pids.json");
    const { outcomes } = await run(
      [
        {
          id: "double-fork",
          argv: [
            NODE,
            "-e",
            "const {spawn}=require('node:child_process');const fs=require('node:fs');" +
              "const a=spawn(process.execPath,['-e',\"const {spawn}=require('node:child_process');" +
              "const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
              "require('node:fs').writeFileSync(process.argv[1],String(b.pid));b.unref();process.exit(0);\"," +
              `${JSON.stringify(pidFile)}],{stdio:'ignore'});a.unref();setInterval(()=>{},1000);`,
          ],
          timeoutMs: 1_500,
        },
      ],
      {},
      dir,
    );

    expect(outcomes[0]?.status).toBe("timed_out");
    const raw = await fs.readFile(pidFile, "utf8").catch(() => "");
    expect(raw).not.toBe("");
    const grandchild = Number(raw);
    strayPids.push(grandchild);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(grandchild)).toBe(false);
  }, 40_000);

  /**
   * DOCUMENTED LIMITATION (Info, not a defect): a grandchild that calls
   * `setsid()` (Node's `detached: true`) leaves the process group, so the
   * `process.kill(-pid, …)` in `src/validation/run.ts:164` cannot reach it.
   * Containing that requires a cgroup / job object, which is out of scope for
   * this tool. This test asserts the escape so the limitation is on the record
   * and so a future containment mechanism has a regression to flip.
   */
  it("cannot reap a grandchild that detaches into its own session", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "detached.pid");
    await run(
      [
        {
          id: "setsid-escape",
          argv: [
            NODE,
            "-e",
            "const {spawn}=require('node:child_process');" +
              "const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)']," +
              "{stdio:'ignore',detached:true});b.unref();" +
              `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(b.pid));` +
              "setInterval(()=>{},1000);",
          ],
          timeoutMs: 1_500,
        },
      ],
      {},
      dir,
    );

    const escaped = Number(await fs.readFile(pidFile, "utf8"));
    strayPids.push(escaped);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(escaped)).toBe(true);
  }, 40_000);

  it("records an exit by signal without pretending it passed", async () => {
    const { outcomes, diagnostics } = await run([
      node("suicide", "process.stdout.write('bye\\n');process.kill(process.pid,'SIGKILL');"),
    ]);
    const outcome = outcomes[0];
    expect(outcome?.status).toBe("failed");
    expect(outcome?.exitCode).toBeNull();
    expect(outcome?.signal).toBe("SIGKILL");
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_FAILED");
  }, 30_000);

  it("closes stdout early then hangs: still timed out, not blocked forever", async () => {
    const started = Date.now();
    const { outcomes } = await run([
      node(
        "close-then-hang",
        "process.stdout.write('early\\n');" +
          "try{require('node:fs').closeSync(1);}catch{}" +
          "setInterval(()=>{},1000);",
        800,
      ),
    ]);
    expect(outcomes[0]?.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it("a nonexistent binary is a spawn_error", async () => {
    const { outcomes } = await run([
      { id: "missing", argv: ["definitely-not-a-real-binary-xyz"], timeoutMs: 5_000 },
    ]);
    expect(outcomes[0]?.status).toBe("spawn_error");
    expect(outcomes[0]?.reason ?? "").toMatch(/ENOENT/);
  }, 30_000);

  it("a directory as the program is a spawn_error", async () => {
    const dir = await tempDir();
    const { outcomes } = await run([{ id: "dir", argv: [dir], timeoutMs: 5_000 }], {}, dir);
    expect(outcomes[0]?.status).toBe("spawn_error");
    expect(outcomes[0]?.exitCode).toBeNull();
  }, 30_000);

  it("a script without the executable bit is a spawn_error", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "not-exec.sh");
    await fs.writeFile(script, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    const { outcomes } = await run([{ id: "noexec", argv: [script], timeoutMs: 5_000 }], {}, dir);
    expect(outcomes[0]?.status).toBe("spawn_error");
    expect(outcomes[0]?.reason ?? "").toMatch(/EACCES/);
  }, 30_000);

  it("honours a timeoutMs larger than 2^31-1", async () => {
    const { outcomes } = await run([
      node("overflowing-timeout", "setTimeout(()=>process.stdout.write('done'),400);", 2 ** 31),
    ]);
    expect(outcomes[0]?.status).toBe("passed");
  }, 40_000);

  it("does not collapse a 2^31 timeout to one millisecond", async () => {
    const { outcomes } = await run([
      node("overflowing-timeout", "setTimeout(()=>process.stdout.write('done'),400);", 2 ** 31),
    ]);
    expect(outcomes[0]?.status).toBe("passed");
    expect(outcomes[0]?.stdout).toBe("done");
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

describe("hostile output", () => {
  it("survives a single 5 MB line with no newline", async () => {
    const { outcomes } = await run(
      [
        node(
          "one-line",
          "const c='y'.repeat(1024*1024);for(let i=0;i<5;i++)process.stdout.write(c);",
        ),
      ],
      { maxOutputBytesPerStream: 4096, maxOutputLinesPerStream: 100 },
    );
    const outcome = outcomes[0];
    expect(outcome?.status).toBe("passed");
    expect(outcome?.truncated.stdout).toBe(true);
    expect(Buffer.byteLength(outcome?.stdout ?? "", "utf8")).toBeLessThanOrEqual(4096);
  }, 40_000);

  it("survives 100k tiny lines and applies the line cap", async () => {
    const { outcomes } = await run(
      [
        node(
          "many-lines",
          "let s='';for(let i=0;i<100000;i++){s+=i+'\\n';if(s.length>65536){process.stdout.write(s);s='';}}" +
            "process.stdout.write(s);",
        ),
      ],
      { maxOutputBytesPerStream: 256 * 1024, maxOutputLinesPerStream: 200 },
    );
    const outcome = outcomes[0];
    expect(outcome?.status).toBe("passed");
    expect(outcome?.truncated.stdout).toBe(true);
    expect((outcome?.stdout ?? "").split("\n").length).toBeLessThanOrEqual(202);
    expect(outcome?.stdout ?? "").toContain("lines elided");
  }, 40_000);

  it("interleaves stdout and stderr at high rate without hanging or crossing streams", async () => {
    const { outcomes } = await run(
      [
        node(
          "interleave",
          "for(let i=0;i<20000;i++){process.stdout.write('O'.repeat(40)+'\\n');" +
            "process.stderr.write('E'.repeat(40)+'\\n');}",
        ),
      ],
      { maxOutputBytesPerStream: 8192, maxOutputLinesPerStream: 5000 },
    );
    const outcome = outcomes[0];
    expect(outcome?.status).toBe("passed");
    expect(outcome?.stdout ?? "").not.toContain("E");
    expect(outcome?.stderr ?? "").not.toContain("O");
    expect(outcome?.truncated.stdout).toBe(true);
    expect(outcome?.truncated.stderr).toBe(true);
  }, 60_000);

  it("strips NUL bytes and never stores a lone surrogate for invalid UTF-8", async () => {
    const { outcomes } = await run([
      node(
        "raw-bytes",
        "process.stdout.write(Buffer.from([0xff,0xfe,0x41,0x00,0x42,0xed,0xa0,0x80,0x0a]));",
      ),
    ]);
    const text = outcomes[0]?.stdout ?? "";
    expect(text).not.toContain(" ");
    for (const unit of text) {
      const code = unit.codePointAt(0) ?? 0;
      expect(code < 0xd800 || code > 0xdfff).toBe(true);
    }
    // JSON must survive it.
    expect(() => JSON.parse(JSON.stringify({ text }))).not.toThrow();
  }, 30_000);

  it("strips an ANSI OSC-8 hyperlink, not only CSI colour codes", async () => {
    const { outcomes } = await run([
      node(
        "osc8",
        "const E=String.fromCharCode(27);const B=String.fromCharCode(7);" +
          "process.stdout.write(E+']8;;https://evil.example/'+B+'click me'+E+']8;;'+B+'\\n');",
      ),
    ]);
    const text = outcomes[0]?.stdout ?? "";
    expect(text).not.toContain("https://evil.example/");
    expect(text).toContain("click me");
    expect(text).not.toContain(String.fromCharCode(27));
  }, 30_000);

  it("does not corrupt a multi-byte character at the byte cap", async () => {
    const { outcomes } = await run(
      [node("multibyte", "process.stdout.write('\\u4e2d'.repeat(500));")],
      { maxOutputBytesPerStream: 100, maxOutputLinesPerStream: 1000 },
    );
    expect(outcomes[0]?.stdout ?? "").not.toContain("�");
  }, 30_000);

  it("keeps every multi-byte cap boundary valid UTF-8", async () => {
    const script = "process.stdout.write('\\u4e2d'.repeat(500));";
    const observed: Array<[number, boolean]> = [];
    for (const cap of [99, 100, 101]) {
      const { outcomes } = await run([node(`mb-${cap}`, script)], {
        maxOutputBytesPerStream: cap,
        maxOutputLinesPerStream: 1000,
      });
      observed.push([cap, (outcomes[0]?.stdout ?? "").includes("�")]);
    }
    expect(observed).toEqual([
      [99, false],
      [100, false],
      [101, false],
    ]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("total validation budget", () => {
  it("denies the tail once many short validations exhaust the budget", async () => {
    const validations = Array.from({ length: 8 }, (_, i) =>
      node(`slow-${i}`, "setTimeout(()=>{},300);", 10_000),
    );
    const { outcomes, diagnostics } = await run(validations, {
      totalValidationBudgetMs: 700,
    });

    expect(outcomes).toHaveLength(8);
    const denied = outcomes.filter((o) => o.status === "denied");
    expect(denied.length).toBeGreaterThan(0);
    for (const outcome of denied) {
      expect(outcome.reason).toContain("total validation time budget exhausted");
    }
    expect(diagnostics.map((d) => d.code)).toContain("E_VALIDATION_DENIED");
    // Ordering is preserved: everything denied comes after everything run.
    const firstDenied = outcomes.findIndex((o) => o.status === "denied");
    expect(outcomes.slice(firstDenied).every((o) => o.status === "denied")).toBe(true);
  }, 60_000);

  it("the total budget constrains the first validation too", async () => {
    const started = Date.now();
    const { outcomes } = await run([node("long", "setTimeout(()=>{},1500);", 10_000)], {
      totalValidationBudgetMs: 100,
    });
    expect(outcomes[0]?.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("environment scrubbing", () => {
  const SECRETS = [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SESSION_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SSH_AUTH_SOCK",
    "GPG_TTY",
    "DOCKER_PASSWORD",
    "SLACK_TOKEN",
    "DATABASE_URL",
    "GIT_ASKPASS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "http_proxy",
    "HTTPS_PROXY",
    "KUBECONFIG",
    "VAULT_TOKEN",
  ];

  it("passes through none of a wide set of sensitive variables", async () => {
    for (const name of SECRETS) setEnv(name, `SECRET-${name}-VALUE`);

    const printer = path.resolve(
      import.meta.dirname,
      "..",
      "helpers",
      "fixtures",
      "print-env.mjs",
    );
    const { outcomes } = await run([
      { id: "env", argv: [NODE, printer, ...SECRETS, "PATH", "CI"], timeoutMs: 20_000 },
    ]);

    const stdout = outcomes[0]?.stdout ?? "";
    expect(outcomes[0]?.status).toBe("passed");
    for (const name of SECRETS) {
      expect([name, stdout.includes(`${name}=<unset>`)]).toEqual([name, true]);
    }
    expect(stdout).not.toContain("SECRET-");
    expect(stdout).toContain("CI=1");
    // PATH, HOME, LANG, TMPDIR + CI, NO_COLOR, FORCE_COLOR, TERM = at most 8.
    // macOS injects __CF_USER_TEXT_ENCODING into a child even when it is not
    // present in the explicit environment object supplied to spawn.
    const count = /ENV_KEY_COUNT=(\d+)/.exec(stdout)?.[1];
    expect(Number(count)).toBeLessThanOrEqual(process.platform === "darwin" ? 9 : 8);
  }, 40_000);

  it("NODE_OPTIONS cannot be used to inject code into a node validation", async () => {
    const dir = await tempDir();
    const marker = path.join(dir, "INJECTED.txt");
    setEnv("NODE_OPTIONS", `--require ${JSON.stringify(marker)}`);

    const { outcomes } = await run(
      [node("plain", "process.stdout.write('ok');")],
      {},
      dir,
    );
    expect(outcomes[0]?.status).toBe("passed");
    expect(outcomes[0]?.stdout).toBe("ok");
  }, 30_000);
});
