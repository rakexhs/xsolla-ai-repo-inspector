/**
 * ADVERSARY-1: hostile input to `src/git/*`.
 *
 * Two classes of attack:
 *   1. argument injection through a caller/model-supplied base ref;
 *   2. filesystem and repository states that are legal but unusual.
 *
 * Absence assertions ("no file was written") carry an in-test **negative
 * control**: the same call shape is run against raw `git` with the defence
 * removed, and the file must appear. That proves the assertion can fail, which
 * is the whole point.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectRepository } from "../../src/git/inspect.js";
import { isSafeGitOperand, runGit, runGitRefs } from "../../src/git/exec.js";
import { reviewRepository } from "../../src/core/review.js";
import { CLI_LIMITS, type Scope } from "../../src/core/types.js";
import { makeRepo, type RepoHandle } from "../helpers/repo.js";

const ALL_SCOPES: Scope[] = ["committed", "staged", "unstaged", "untracked"];

const repos: RepoHandle[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.().catch(() => {});
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function repo(name = "repo"): Promise<RepoHandle> {
  const handle = await makeRepo(name);
  repos.push(handle);
  return handle;
}

function inspect(repositoryPath: string, baseRef?: string) {
  return inspectRepository({
    repositoryPath,
    ...(baseRef !== undefined ? { baseRef } : {}),
    scopes: ALL_SCOPES,
    maxFilesPerScope: CLI_LIMITS.maxFilesPerScope,
    timeoutMs: 10_000,
  });
}

function rawGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, () => resolve());
  });
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Argument injection through the base ref
// ---------------------------------------------------------------------------

describe("hostile base refs", () => {
  const optionShaped = [
    "--output=X",
    "--upload-pack=X",
    "--exec-path=X",
    "-c",
    "-c core.pager=X",
    "-",
    "--",
    "--no-such-flag",
  ];

  for (const ref of optionShaped) {
    it(`refuses an option-shaped base ref: ${JSON.stringify(ref)}`, async () => {
      const handle = await repo();
      await handle.write("a.txt", "a");
      await handle.commit("one");

      const outcome = await inspect(handle.dir, ref);
      const codes = outcome.diagnostics.map((d) => d.code);
      expect(codes).toContain("E_BASE_REF_UNKNOWN");
      expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(true);
    });
  }

  const controlShaped: Array<[string, string]> = [
    ["newline", "main\nrefs/heads/x"],
    ["carriage return", "main\rx"],
    ["NUL", `main${String.fromCharCode(0)}x`],
    ["tab", "main\tx"],
    ["DEL", `main${String.fromCharCode(0x7f)}`],
    ["ESC", `main${String.fromCharCode(27)}[31m`],
  ];

  for (const [label, ref] of controlShaped) {
    it(`refuses a base ref containing a ${label}`, async () => {
      const handle = await repo();
      await handle.write("a.txt", "a");
      await handle.commit("one");

      const outcome = await inspect(handle.dir, ref);
      expect(outcome.diagnostics.map((d) => d.code)).toContain(
        "E_BASE_REF_UNKNOWN",
      );
    });
  }

  /**
   * The load-bearing test: `--output=<file>` must not cause a file write.
   *
   * NEGATIVE CONTROL is built in — the second half runs the starter's exact
   * call shape with no `--end-of-options` and asserts the file *is* created.
   * If the defence were removed, the first assertion would fail; if the control
   * ever stops writing the file, the test as a whole is meaningless and says so.
   */
  it("--output= base ref writes no file (with negative control)", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");

    const victim = path.join(handle.root, "PWNED.txt");
    const outcome = await inspect(handle.dir, `--output=${victim}`);

    expect(outcome.diagnostics.map((d) => d.code)).toContain(
      "E_BASE_REF_UNKNOWN",
    );
    expect(await existsPath(victim)).toBe(false);
    expect(await existsPath(`${victim}...HEAD`)).toBe(false);

    // --- negative control: the undefended shape must actually write ---------
    const control = path.join(handle.root, "CONTROL.txt");
    await rawGit(handle.dir, [
      "diff",
      "--name-status",
      `--output=${control}...HEAD`,
    ]);
    expect(await existsPath(`${control}...HEAD`)).toBe(true);
  });

  /** `runGit`'s central guard, exercised directly rather than via inspect. */
  it("runGitRefs refuses to spawn when an operand looks like an option", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");

    const victim = path.join(handle.root, "PWNED2.txt");
    const result = await runGitRefs(
      handle.dir,
      ["diff", "--name-status"],
      [`--output=${victim}`],
      10_000,
      { pathspecTerminator: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toContain("refusing unsafe git operand");
    expect(await existsPath(victim)).toBe(false);
  });

  it("runGit refuses any argument containing a NUL byte", async () => {
    const handle = await repo();
    const result = await runGit(
      handle.dir,
      ["status", `--porcelain${String.fromCharCode(0)}`],
      10_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toContain("NUL");
  });

  it("isSafeGitOperand rejects the whole option-shaped family", () => {
    for (const bad of [
      "",
      "-",
      "--",
      "-c",
      "--output=x",
      "--upload-pack=x",
      "--exec-path=x",
      "\n",
      String.fromCharCode(0),
      String.fromCharCode(0x7f),
    ]) {
      expect([bad, isSafeGitOperand(bad)]).toEqual([bad, false]);
    }
    for (const good of ["main", "HEAD", "HEAD~1", "@{-1}", "HEAD@{999}", ":/x", "v1.0"]) {
      expect([good, isSafeGitOperand(good)]).toEqual([good, true]);
    }
  });

  /**
   * Revision syntax that is *not* option-shaped is allowed through to git, as
   * it must be. These must resolve or produce a clean fatal diagnostic, never
   * a throw and never a hang.
   */
  const exoticRefs = ["@{-1}", "HEAD@{999}", ":/nothing-matches-this", "HEAD^{tree}", "@"];
  for (const ref of exoticRefs) {
    it(`handles exotic revision syntax cleanly: ${ref}`, async () => {
      const handle = await repo();
      await handle.write("a.txt", "a");
      await handle.commit("one");

      const outcome = await inspect(handle.dir, ref);
      expect(Array.isArray(outcome.diagnostics)).toBe(true);
      // Whatever happens, the outcome is well-formed.
      expect(outcome.repository.path.length).toBeGreaterThan(0);
      expect(outcome.changes.counts.distinctFiles).toBeGreaterThanOrEqual(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Hostile repository paths
// ---------------------------------------------------------------------------

describe("hostile repository paths", () => {
  it("a path that is a regular file", async () => {
    const handle = await repo();
    await handle.write("plain.txt", "x");
    const outcome = await inspect(path.join(handle.dir, "plain.txt"));
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
    expect(outcome.diagnostics[0]?.message).toContain("not a directory");
  });

  it("a broken symlink", async () => {
    const handle = await repo();
    const link = path.join(handle.root, "dangling");
    await fs.symlink(path.join(handle.root, "does-not-exist"), link);
    const outcome = await inspect(link);
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
    expect(outcome.diagnostics[0]?.severity).toBe("fatal");
  });

  it("a FIFO", async () => {
    const handle = await repo();
    const fifo = path.join(handle.root, "pipe");
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [fifo], (error) => (error ? reject(error) : resolve()));
    });
    const outcome = await inspect(fifo);
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
  });

  it("a directory with no read or execute permission", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const handle = await repo();
    const locked = path.join(handle.root, "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    cleanups.push(async () => {
      await fs.chmod(locked, 0o755).catch(() => {});
    });

    const outcome = await inspect(locked);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.severity).toBe("fatal");
    // Never a stack trace, never an unhandled rejection.
    expect(outcome.changes.counts.distinctFiles).toBe(0);
  });

  it("a path with a trailing newline", async () => {
    const handle = await repo();
    const outcome = await inspect(`${handle.dir}\n`);
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
  });

  it("the empty string", async () => {
    const outcome = await inspect("");
    expect(outcome.diagnostics[0]?.severity).toBe("fatal");
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
  });

  for (const relative of [".", ".."]) {
    it(`a relative path (${relative}) produces a well-formed outcome`, async () => {
      // Documents the behaviour rather than blessing it: the core contract says
      // repositoryPath is "absolute, already canonicalised", and nothing here
      // enforces that. A relative path is silently resolved against the host
      // process's cwd.
      const outcome = await inspect(relative);
      expect(Array.isArray(outcome.diagnostics)).toBe(true);
      expect(typeof outcome.repository.path).toBe("string");
    });
  }

  it("a very long path near PATH_MAX", async () => {
    const handle = await repo();
    // 200-byte components until the total is close to the 1024-byte macOS
    // PATH_MAX; creation itself may fail, which is fine — nothing may throw.
    let deep = handle.root;
    try {
      for (let i = 0; i < 4; i += 1) {
        deep = path.join(deep, "l".repeat(200));
        await fs.mkdir(deep);
      }
    } catch {
      // Filesystem refused; the inspection assertion below is still valid.
    }
    const outcome = await inspect(deep);
    expect(outcome.diagnostics[0]?.severity).toBe("fatal");
  });

  it("the .git directory itself has no work tree", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");
    const outcome = await inspect(path.join(handle.dir, ".git"));
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
    expect(outcome.diagnostics[0]?.message).toContain("no work tree");
  });
});

// ---------------------------------------------------------------------------
// 3. Repository directory names that are legal but hostile
// ---------------------------------------------------------------------------

describe("hostile repository directory names", () => {
  it("survives a directory name containing a space and a newline", async () => {
    const handle = await repo("has space\nand-newline");
    await handle.write("a.txt", "a");
    await handle.commit("one");

    const outcome = await inspect(handle.dir);
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(outcome.repository.path).toBe(handle.dir);
  });

  it(
    "reports the correct repository.path for a work tree whose name ends in a space",
    async () => {
      const handle = await repo("trailing space ");
      await handle.write("a.txt", "a");
      await handle.commit("one");

      const outcome = await inspect(handle.dir);
      expect(outcome.repository.path).toBe(handle.dir);
    },
  );

  it(
    "runs validations in the real work tree for a name ending in a space",
    async () => {
      const handle = await repo("trailing space ");
      await handle.write("a.txt", "a");
      await handle.commit("one");

      const result = await reviewRepository({
        repositoryPath: handle.dir,
        scopes: ["unstaged", "untracked"],
        detail: "full",
        validations: [
          {
            id: "pwd",
            argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
            timeoutMs: 20_000,
          },
        ],
        denied: [],
        limits: CLI_LIMITS,
      });

      expect(result.validations[0]?.status).toBe("passed");
    },
    60_000,
  );

  it("keeps trailing whitespace when resolving a repository root", async () => {
    const handle = await repo("trailing space ");
    await handle.write("a.txt", "a");
    await handle.commit("one");

    const outcome = await inspect(handle.dir);
    expect(outcome.repository.path).toBe(handle.dir);
    expect(await existsPath(outcome.repository.path)).toBe(true);

    const result = await reviewRepository({
      repositoryPath: handle.dir,
      scopes: ["unstaged"],
      detail: "full",
      validations: [
        {
          id: "pwd",
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
          timeoutMs: 20_000,
        },
      ],
      denied: [],
      limits: CLI_LIMITS,
    });
    expect(result.validations[0]?.status).toBe("passed");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Unusual repository states
// ---------------------------------------------------------------------------

describe("unusual repository states", () => {
  it("a bare repository is refused with a specific message", async () => {
    const handle = await repo();
    const bare = path.join(handle.root, "bare.git");
    await fs.mkdir(bare);
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "-q", "--bare", "."], { cwd: bare }, (e) =>
        e ? reject(e) : resolve(),
      );
    });
    const outcome = await inspect(bare);
    expect(outcome.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
    expect(outcome.diagnostics[0]?.hint).toContain("Bare repositories");
  });

  it("a linked worktree, where .git is a file", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");
    const linked = path.join(handle.root, "linked");
    await handle.run("worktree", "add", "-q", "-b", "wt", linked);

    const gitEntry = await fs.stat(path.join(linked, ".git"));
    expect(gitEntry.isFile()).toBe(true);

    await fs.writeFile(path.join(linked, "b.txt"), "b", "utf8");
    const outcome = await inspect(linked);
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(outcome.changes.untracked.map((f) => f.path)).toContain("b.txt");
  });

  it("HEAD pointing at a nonexistent ref", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");
    await handle.run("symbolic-ref", "HEAD", "refs/heads/does-not-exist");

    const outcome = await inspect(handle.dir);
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(outcome.repository.head.unborn).toBe(true);
    expect(outcome.repository.head.branch).toBe("does-not-exist");
  });

  it("a corrupt .git/HEAD does not throw", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    await handle.commit("one");
    await fs.writeFile(
      path.join(handle.dir, ".git", "HEAD"),
      "this is not a ref\n",
      "utf8",
    );

    const outcome = await inspect(handle.dir);
    // Whatever git decides, the outcome must be well-formed with a diagnostic
    // rather than an exception escaping the module.
    expect(Array.isArray(outcome.diagnostics)).toBe(true);
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
  });

  it("a repository mid-merge with conflicts reports W_UNMERGED_PATHS", async () => {
    const handle = await repo();
    await handle.write("c.txt", "base\n");
    await handle.commit("base");
    await handle.run("checkout", "-q", "-b", "other");
    await handle.write("c.txt", "other\n");
    await handle.commit("other");
    await handle.run("checkout", "-q", "main");
    await handle.write("c.txt", "main\n");
    await handle.commit("main");
    await handle.run("merge", "other").catch(() => undefined);

    const outcome = await inspect(handle.dir);
    expect(outcome.diagnostics.map((d) => d.code)).toContain("W_UNMERGED_PATHS");
    expect(outcome.changes.unstaged.some((f) => f.path === "c.txt")).toBe(true);
  });

  it("a .gitignore that ignores everything yields no untracked entries", async () => {
    const handle = await repo();
    await handle.write(".gitignore", "*\n");
    await handle.write("secret.txt", "s");
    const outcome = await inspect(handle.dir);
    expect(outcome.changes.untracked).toHaveLength(0);
    expect(outcome.changes.counts.untracked).toBe(0);
  });

  it("2000 changed files: counts stay pre-truncation and the cap holds", async () => {
    const handle = await repo();
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) =>
        handle.write(`f/${String(i).padStart(5, "0")}.txt`, "x"),
      ),
    );

    const outcome = await inspectRepository({
      repositoryPath: handle.dir,
      scopes: ["untracked"],
      maxFilesPerScope: 1000,
      timeoutMs: 30_000,
    });

    expect(outcome.changes.counts.untracked).toBe(2000);
    expect(outcome.changes.counts.distinctFiles).toBe(2000);
    expect(outcome.changes.untracked).toHaveLength(1000);
    expect(outcome.changes.files).toHaveLength(1000);
    expect(outcome.changes.listTruncated).toBe(true);
  }, 120_000);

  it("filenames that mimic git status codes are parsed as paths", async () => {
    const handle = await repo();
    for (const name of ["R100", "?? evil", "UU conflicted", "D  spaced", "A"]) {
      await handle.write(name, "x");
    }
    const outcome = await inspect(handle.dir);
    const paths = outcome.changes.untracked.map((f) => f.path);
    expect(paths).toContain("R100");
    expect(paths).toContain("?? evil");
    expect(paths).toContain("UU conflicted");
    expect(paths).toContain("D  spaced");
    expect(paths).toContain("A");
  });

  it("a file literally named --output=x is listed and never becomes an operand", async () => {
    const handle = await repo();
    await handle.write("--output=x", "x");
    const victim = path.join(handle.root, "x");

    const outcome = await inspect(handle.dir);
    expect(outcome.changes.untracked.map((f) => f.path)).toContain("--output=x");
    expect(await existsPath(victim)).toBe(false);
  });

  it("exotic filenames survive the -z pipeline byte-for-byte", async () => {
    const handle = await repo();
    const names = [
      "trailing space ",
      "\n",
      "a\nb.txt",
      "tab\there.txt",
      "quote\"and'quote.txt",
      "back\\slash.txt",
      "é中文.txt",
      "-".repeat(30),
      "z".repeat(255),
    ];
    for (const name of names) await handle.write(name, "x");

    const outcome = await inspect(handle.dir);
    const paths = new Set(outcome.changes.untracked.map((f) => f.path));
    for (const name of names) {
      expect([name, paths.has(name)]).toEqual([name, true]);
    }
  });

  it("reports Git's nested-repository marker without descending into it", async () => {
    const handle = await repo();
    const inner = path.join(handle.dir, "inner");
    await fs.mkdir(inner);
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "-q", "."], { cwd: inner }, (e) =>
        e ? reject(e) : resolve(),
      );
    });
    await fs.writeFile(path.join(inner, "n.txt"), "n", "utf8");

    const outcome = await inspect(handle.dir);
    expect(outcome.changes.untracked).toContainEqual({
      path: "inner/",
      status: "untracked",
      kind: "directory",
    });
    expect(outcome.changes.files).toContainEqual({
      path: "inner/",
      status: "untracked",
      scopes: ["untracked"],
      kind: "directory",
    });
  });

  it("a 255-byte filename round-trips", async () => {
    const handle = await repo();
    const name = `${"n".repeat(251)}.txt`;
    expect(Buffer.byteLength(name, "utf8")).toBe(255);
    await handle.write(name, "x");
    const outcome = await inspect(handle.dir);
    expect(outcome.changes.untracked.map((f) => f.path)).toContain(name);
  });

  it("an unborn repository with untracked files degrades rather than dying", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    const outcome = await inspect(handle.dir);
    expect(outcome.diagnostics.map((d) => d.code)).toContain("W_NO_COMMITS");
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(outcome.repository.head.unborn).toBe(true);
    expect(outcome.changes.untracked.map((f) => f.path)).toContain("a.txt");
  });
});

// ---------------------------------------------------------------------------
// 5. Environment scrubbing for git itself
// ---------------------------------------------------------------------------

describe("git environment isolation", () => {
  it("ignores an inherited GIT_DIR pointing at another repository", async () => {
    const a = await repo("a");
    await a.write("in-a.txt", "a");
    await a.commit("a");
    const b = await repo("b");
    await b.write("in-b.txt", "b");

    const previous = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = path.join(a.dir, ".git");
    cleanups.push(async () => {
      if (previous === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = previous;
    });

    const outcome = await inspect(b.dir);
    expect(outcome.repository.path).toBe(b.dir);
    expect(outcome.changes.untracked.map((f) => f.path)).toContain("in-b.txt");
  });

  it("ignores an inherited GIT_INDEX_FILE", async () => {
    const handle = await repo();
    await handle.write("a.txt", "a");
    const bogusIndex = path.join(os.tmpdir(), "inspector-adv-bogus-index");
    const previous = process.env["GIT_INDEX_FILE"];
    process.env["GIT_INDEX_FILE"] = bogusIndex;
    cleanups.push(async () => {
      if (previous === undefined) delete process.env["GIT_INDEX_FILE"];
      else process.env["GIT_INDEX_FILE"] = previous;
      await fs.rm(bogusIndex, { force: true }).catch(() => {});
    });

    const outcome = await inspect(handle.dir);
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(await existsPath(bogusIndex)).toBe(false);
  });
});
