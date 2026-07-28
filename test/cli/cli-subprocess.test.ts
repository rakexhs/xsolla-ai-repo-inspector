/**
 * End-to-end tests against the real CLI binary.
 *
 * These spawn `node --import tsx src/cli/main.ts` as a genuine child process
 * and assert only on the observable contract — the `{ stdout, stderr, exitCode }`
 * triple. That is deliberate: the defects being regressed here (a crash that
 * still exited 0, a stack trace dumped to the terminal, a report accidentally
 * interleaved with log lines on stdout) are *only* visible from outside the
 * process. An in-process test that called `main()` would have passed against
 * the starter.
 *
 * No shell is ever used: `execFile`, not `exec`. Fixture repositories live in
 * paths containing spaces, and a shell would silently re-split them — which is
 * the exact bug the headline test below exists to catch.
 *
 * `--import tsx` was measured at ~0.15 s per spawn against ~0.57 s for
 * `npx tsx`, so the loader is invoked directly. It resolves `tsx` relative to
 * the *cwd*, so every child runs with `cwd` pinned to the project root; the CLI
 * itself never depends on cwd because `--repo` is always absolute here.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeRepo, type RepoHandle } from "../helpers/repo.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = path.join(PROJECT_ROOT, "src", "cli", "main.ts");
const FIXTURES = path.join(PROJECT_ROOT, "test", "helpers", "fixtures");

/** A stack frame as V8 prints it. Its presence in stderr is always a defect. */
const STACK_FRAME = /at .*\(.*:\d+:\d+\)/;

type CliResult = { stdout: string; stderr: string; exitCode: number };

function runCli(args: string[]): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", ENTRY, ...args],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        // Warnings from the loader would pollute the stderr assertions, and
        // this suite asserts on stderr precisely.
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") {
          resolve({ stdout, stderr, exitCode: code });
          return;
        }
        // A signal or a spawn failure is never an expected outcome here.
        reject(new Error(`CLI did not exit normally: ${error.message}`));
      },
    );
  });
}

/** The version the binary must report, read from the manifest, never hardcoded. */
function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("package.json has no version");
  return version;
}

/** An ad-hoc command string for a fixture script. No shell metacharacters. */
function fixtureCommand(script: string, ...args: string[]): string {
  return [process.execPath, path.join(FIXTURES, script), ...args].join(" ");
}

const repos: RepoHandle[] = [];

async function repoWithChanges(name = "has space"): Promise<RepoHandle> {
  const repo = await makeRepo(name);
  repos.push(repo);
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("initial");
  await repo.write("src/a.ts", "export const a = 2;\n");
  await repo.write("docs/new file.md", "# new\n");
  return repo;
}

async function cleanRepo(name = "clean"): Promise<RepoHandle> {
  const repo = await makeRepo(name);
  repos.push(repo);
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("initial");
  return repo;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

// ---------------------------------------------------------------------------

describe("--help and --version", () => {
  it("prints help to stdout and exits 0", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("inspector review --repo <path>");
  });

  it("documents every flag the parser accepts", async () => {
    // Imported lazily so the assertion tracks the parser, not a second list
    // that could drift from it.
    const { ALL_FLAGS } = await import("../../src/cli/args.js");
    const help = (await runCli(["--help"])).stdout;
    for (const flag of ALL_FLAGS) {
      expect(help, `--help must document ${flag}`).toContain(flag);
    }
  });

  it("prints the package.json version and exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`inspector ${packageVersion()}`);
    expect(result.stdout).not.toContain("unknown");
  });
});

describe("usage errors exit 2", () => {
  it("no arguments", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no subcommand");
    expect(result.stderr).toContain("--help");
  });

  it("unknown flag", async () => {
    const result = await runCli(["review", "--repo", ".", "--colour"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option");
  });

  it("unknown subcommand", async () => {
    const result = await runCli(["inspect", "--repo", "."]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown subcommand");
  });

  it("--validate with no value (starter: ERR_INVALID_ARG_TYPE crash, exit 0)", async () => {
    const result = await runCli(["review", "--repo", ".", "--validate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--validate requires a value");
    // The starter crashed inside child_process and printed the whole error.
    expect(result.stderr).not.toContain("ERR_INVALID_ARG_TYPE");
    expect(result.stderr).not.toMatch(STACK_FRAME);
  });

  it("--validate with shell metacharacters, naming the offender", async () => {
    const repo = await cleanRepo();
    const result = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--validate",
      "npm test && npm run lint",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("metacharacter");
    expect(result.stderr).toContain("&");
    expect(result.stderr).not.toMatch(STACK_FRAME);
  });
});

describe("inspection failures exit 3 without a stack trace", () => {
  it("--base-ref that does not resolve", async () => {
    const repo = await cleanRepo();
    const result = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--base-ref",
      "does-not-exist",
      "--out",
      "-",
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("E_BASE_REF_UNKNOWN");
    // The permanent regression: the starter printed a multi-screen Node error
    // object containing `[Circular *1]` for exactly this input.
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stderr).not.toContain("[Circular");
  });

  it("a --repo path that does not exist", async () => {
    const result = await runCli(["review", "--repo", "/nonexistent/inspector target"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("E_NOT_A_REPO");
    expect(result.stderr).not.toMatch(STACK_FRAME);
  });
});

describe("the headline regression: a repository path containing spaces", () => {
  it("inspects it correctly and exits 0", async () => {
    const repo = await repoWithChanges("my project dir");
    expect(repo.dir).toContain(" ");

    const result = await runCli(["review", "--repo", repo.dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // The starter truncated the path at the first space and then reported on
    // whatever directory happened to be there.
    expect(result.stdout).toContain(repo.dir);
    expect(result.stdout).toContain("src/a.ts");
    expect(result.stdout).toContain("docs/new file.md");
  });
});

describe("output discipline", () => {
  it("--format json puts parseable JSON on stdout and nothing on stderr", async () => {
    const repo = await repoWithChanges();
    const result = await runCli(["review", "--repo", repo.dir, "--format", "json"]);

    expect(result.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect((parsed as { schemaVersion?: unknown }).schemaVersion).toBe(1);
    expect((parsed as { repository: { path: string } }).repository.path).toBe(repo.dir);

    expect(result.stderr).toBe("");
    expect(result.stderr).not.toContain("{");
  });

  it("--out <file> writes the report and leaves stdout empty", async () => {
    const repo = await repoWithChanges();
    const target = path.join(repo.root, "report file.md");

    const result = await runCli(["review", "--repo", repo.dir, "--out", target]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // The confirmation belongs on stderr, never on stdout.
    expect(result.stderr).toContain("report written to");
    expect(result.stderr).toContain(target);

    const written = await readFile(target, "utf8");
    expect(written).toContain("# Repository review");
    expect(written).toContain("src/a.ts");
  });

  it("--out - writes the same bytes to stdout", async () => {
    const repo = await repoWithChanges();
    const target = path.join(repo.root, "report.md");

    const toStdout = await runCli(["review", "--repo", repo.dir, "--out", "-"]);
    await runCli(["review", "--repo", repo.dir, "--out", target]);
    const toFile = await readFile(target, "utf8");

    expect(toStdout.stdout).toBe(toFile);
  });
});

describe("exit codes", () => {
  it("a clean repository with no validations exits 0", async () => {
    const repo = await cleanRepo();
    const result = await runCli(["review", "--repo", repo.dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("**PASSED**");
  });

  it("a failing ad-hoc validation exits 1 and the review still completed", async () => {
    const repo = await repoWithChanges();
    const result = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--validate",
      fixtureCommand("exit-with.mjs", "3", "unit"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("**FAILED**");
    // The report must still carry the change list: exit 1 means "your code is
    // failing", not "the tool gave up".
    expect(result.stdout).toContain("src/a.ts");
    expect(result.stdout).toContain("docs/new file.md");
    expect(result.stdout).toContain("unit: stdout line");
    expect(result.stderr).not.toMatch(STACK_FRAME);
  });

  it("--exit-zero turns a failing validation into exit 0", async () => {
    const repo = await repoWithChanges();
    const args = [
      "review",
      "--repo",
      repo.dir,
      "--validate",
      fixtureCommand("exit-with.mjs", "3", "unit"),
    ];

    expect((await runCli(args)).exitCode).toBe(1);

    const forgiving = await runCli([...args, "--exit-zero"]);
    expect(forgiving.exitCode).toBe(0);
    // The report is unchanged; only the process exit code differs.
    expect(forgiving.stdout).toContain("**FAILED**");
  });

  it("a passing ad-hoc validation exits 0", async () => {
    const repo = await cleanRepo();
    const result = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--validate",
      fixtureCommand("exit-with.mjs", "0", "unit"),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("**PASSED**");
  });

  it("an unknown --validation name exits 2", async () => {
    const repo = await cleanRepo();
    const result = await runCli(["review", "--repo", repo.dir, "--validation", "nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("E_VALIDATION_UNKNOWN");
    expect(result.stdout).toBe("");
  });
});

describe("--detail", () => {
  it("summary is materially smaller than full for the same repository", async () => {
    const repo = await repoWithChanges();
    const args = ["review", "--repo", repo.dir, "--validate", fixtureCommand("exit-with.mjs", "0", "unit")];

    const full = await runCli([...args, "--detail", "full"]);
    const summary = await runCli([...args, "--detail", "summary"]);

    expect(full.exitCode).toBe(0);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).not.toBe(full.stdout);
    expect(summary.stdout.length).toBeLessThan(full.stdout.length);
    // The difference is captured output, which `full` keeps and `summary` drops
    // for a validation that passed.
    expect(full.stdout).toContain("unit: stdout line");
    expect(summary.stdout).not.toContain("unit: stdout line");
    expect(summary.stdout).toContain("Detail: `summary`");
  });
});

describe("--scope", () => {
  it("worktree omits the committed scope from the report", async () => {
    const repo = await repoWithChanges();
    const result = await runCli(["review", "--repo", repo.dir, "--scope", "worktree", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { scopes: string[] };
    expect(parsed.scopes).toEqual(["staged", "unstaged", "untracked"]);
  });
});
