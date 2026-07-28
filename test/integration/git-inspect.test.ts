/**
 * End-to-end inspection tests against real repositories in temp directories.
 *
 * No mocking of `child_process`: every assertion below is about what Git
 * actually emits, which is the only thing that can catch a framing or
 * ref-resolution mistake. Each fixture temp directory name contains a space
 * (see `makeRepo`), so the whole suite is a standing regression against the
 * starter's shell-interpolated, space-splitting invocation.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGit, runGitRefs } from "../../src/git/exec.js";
import type { InspectOptions, InspectOutcome } from "../../src/git/inspect.js";
import { inspectRepository } from "../../src/git/inspect.js";
import { SCOPES } from "../../src/core/types.js";
import type { RepoHandle } from "../helpers/repo.js";
import { makePlainDir, makeRepo } from "../helpers/repo.js";

const ALL_SCOPES = [...SCOPES];

const handles: RepoHandle[] = [];

async function repo(name?: string): Promise<RepoHandle> {
  const handle = await makeRepo(name);
  handles.push(handle);
  return handle;
}

async function plainDir(): Promise<RepoHandle> {
  const handle = await makePlainDir();
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()));
});

function inspect(
  repositoryPath: string,
  overrides: Partial<InspectOptions> = {},
): Promise<InspectOutcome> {
  return inspectRepository({
    repositoryPath,
    scopes: ALL_SCOPES,
    maxFilesPerScope: 1000,
    timeoutMs: 20_000,
    ...overrides,
  });
}

const codes = (outcome: InspectOutcome): string[] =>
  outcome.diagnostics.map((d) => d.code);

const fatals = (outcome: InspectOutcome): string[] =>
  outcome.diagnostics.filter((d) => d.severity === "fatal").map((d) => d.code);

const paths = (files: { path: string }[]): string[] => files.map((f) => f.path);

// ---------------------------------------------------------------------------
// Degraded but usable states
// ---------------------------------------------------------------------------

describe("repositories without usable history", () => {
  it("reports an unborn HEAD as a warning and still lists untracked files", async () => {
    const handle = await repo();
    await handle.write("scaffold.ts", "export const x = 1;\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.head).toEqual({
      unborn: true,
      detached: false,
      sha: null,
      branch: "main",
    });
    expect(outcome.repository.base).toBeNull();
    expect(codes(outcome)).toContain("W_NO_COMMITS");
    expect(paths(outcome.changes.untracked)).toEqual(["scaffold.ts"]);
    expect(outcome.changes.committed).toEqual([]);
    expect(outcome.changes.counts.distinctFiles).toBe(1);
  });

  it("does not fail when the only branch is named trunk and no main exists", async () => {
    // Direct regression of the hardcoded `main` base in the starter.
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.run("branch", "-m", "trunk");
    await handle.write("untracked.txt", "new\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.head.branch).toBe("trunk");
    expect(outcome.repository.base).toBeNull();
    expect(codes(outcome)).toContain("W_NO_BASE_REF");
    expect(paths(outcome.changes.untracked)).toEqual(["untracked.txt"]);
  });

  it("auto-detects origin/HEAD when it points at a non-conventional branch", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    const first = await handle.commit("initial");
    await handle.run("branch", "-m", "trunk");
    await handle.run("update-ref", "refs/remotes/origin/trunk", first);
    await handle.run(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    await handle.write("b.txt", "two\n");
    await handle.commit("second");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.base?.ref).toBe("origin/trunk");
    expect(outcome.repository.base?.autoDetected).toBe(true);
    expect(outcome.repository.base?.requested).toBeNull();
    expect(outcome.repository.base?.mergeBase).toBe(first);
    expect(paths(outcome.changes.committed)).toEqual(["b.txt"]);
  });

  it("falls back to origin/master when no local main exists", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    const first = await handle.commit("initial");
    await handle.run("branch", "-m", "trunk");
    await handle.run("update-ref", "refs/remotes/origin/master", first);
    await handle.write("b.txt", "two\n");
    await handle.commit("second");

    const outcome = await inspect(handle.dir);

    expect(outcome.repository.base?.ref).toBe("origin/master");
    expect(paths(outcome.changes.committed)).toEqual(["b.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Committed scope
// ---------------------------------------------------------------------------

describe("committed changes against a base", () => {
  it("reports add, modify and delete on a feature branch", async () => {
    const handle = await repo();
    await handle.write("keep.txt", "keep\n");
    await handle.write("change.txt", "before\n");
    await handle.write("gone.txt", "doomed\n");
    const base = await handle.commit("initial");

    await handle.run("checkout", "-q", "-b", "feature");
    await handle.write("added.txt", "brand new\n");
    await handle.write("change.txt", "after\n");
    await handle.remove("gone.txt");
    await handle.commit("feature work");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.base?.ref).toBe("main");
    expect(outcome.repository.base?.mergeBase).toBe(base);
    expect(outcome.changes.committed).toEqual([
      { path: "added.txt", status: "added" },
      { path: "change.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
    ]);
    // Only names and statuses: nothing carries diff content.
    expect(JSON.stringify(outcome.changes)).not.toContain("brand new");
    expect(outcome.changes.counts.committed).toBe(3);
    expect(outcome.changes.staged).toEqual([]);
    expect(outcome.changes.unstaged).toEqual([]);
  });

  it("detects a git mv as a rename with origPath and a score", async () => {
    const handle = await repo();
    // Enough content that Git is confident about the similarity.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    await handle.write("src/original name.txt", body);
    await handle.commit("initial");

    await handle.run("checkout", "-q", "-b", "feature");
    await handle.run("mv", "src/original name.txt", "src/new name.txt");
    await handle.commit("rename");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.changes.committed).toHaveLength(1);
    const [file] = outcome.changes.committed;
    expect(file?.status).toBe("renamed");
    expect(file?.path).toBe("src/new name.txt");
    expect(file?.origPath).toBe("src/original name.txt");
    expect(file?.score).toBe(100);
    // The summary follows the new path, and only the new path.
    expect(paths(outcome.changes.files)).toEqual(["src/new name.txt"]);
  });

  it("fails loudly on unrelated histories", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial on main");

    await handle.run("checkout", "-q", "--orphan", "orphan-branch");
    await handle.run("rm", "-rf", "-q", ".");
    await handle.write("b.txt", "two\n");
    await handle.commit("initial on orphan");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual(["E_NO_MERGE_BASE"]);
    expect(outcome.changes.committed).toEqual([]);
    expect(outcome.changes.listTruncated).toBe(false);
    expect(outcome.changes.counts.distinctFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Working-tree scopes
// ---------------------------------------------------------------------------

describe("working-tree scopes", () => {
  it("lists a file that is both staged and unstaged once in files, twice in scopes", async () => {
    const handle = await repo();
    await handle.write("both.txt", "v1\n");
    await handle.commit("initial");

    await handle.write("both.txt", "v2\n");
    await handle.run("add", "both.txt");
    await handle.write("both.txt", "v3\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(paths(outcome.changes.staged)).toEqual(["both.txt"]);
    expect(paths(outcome.changes.unstaged)).toEqual(["both.txt"]);
    expect(outcome.changes.files).toEqual([
      { path: "both.txt", status: "modified", scopes: ["staged", "unstaged"] },
    ]);
    expect(outcome.changes.counts).toMatchObject({
      staged: 1,
      unstaged: 1,
      distinctFiles: 1,
    });
  });

  it("excludes gitignored files from the untracked list", async () => {
    const handle = await repo();
    await handle.write(".gitignore", "ignored.txt\nbuild/\n");
    await handle.commit("add gitignore");

    await handle.write("visible.txt", "see me\n");
    await handle.write("ignored.txt", "hide me\n");
    await handle.write("build/artifact.bin", "binary\n");

    const outcome = await inspect(handle.dir);

    expect(paths(outcome.changes.untracked)).toEqual(["visible.txt"]);
    expect(JSON.stringify(outcome.changes)).not.toContain("ignored.txt");
    expect(JSON.stringify(outcome.changes)).not.toContain("artifact.bin");
  });

  it("handles paths containing a space, a newline and non-ASCII characters", async () => {
    const handle = await repo();
    await handle.write("seed.txt", "seed\n");
    await handle.commit("initial");

    const spaced = "dir with space/file name.txt";
    const newline = "weird\nname.txt";
    const unicode = "docs/café/日本語.md";
    await handle.write(spaced, "a\n");
    await handle.write(newline, "b\n");
    await handle.write(unicode, "c\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(new Set(paths(outcome.changes.untracked))).toEqual(
      new Set([spaced, newline, unicode]),
    );
    expect(outcome.changes.counts.untracked).toBe(3);
  });

  it("works when the containing directory name has a space in it", async () => {
    // The starter interpolated this path into a shell string and split it.
    const handle = await repo("project with space");
    expect(handle.dir).toContain(" ");
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.write("b.txt", "two\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.path).toBe(handle.dir);
    expect(paths(outcome.changes.untracked)).toEqual(["b.txt"]);
  });

  it("reports a detached HEAD as a warning and still produces results", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.write("b.txt", "two\n");
    const second = await handle.commit("second");
    await handle.run("checkout", "-q", "--detach", second);
    await handle.write("scratch.txt", "scratch\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.head.detached).toBe(true);
    expect(outcome.repository.head.branch).toBeNull();
    expect(outcome.repository.head.sha).toBe(second);
    expect(codes(outcome)).toContain("W_DETACHED_HEAD");
    expect(paths(outcome.changes.untracked)).toEqual(["scratch.txt"]);
  });

  it("warns about unmerged paths during a conflicted merge", async () => {
    const handle = await repo();
    await handle.write("conflict.txt", "base\n");
    await handle.commit("initial");
    await handle.run("checkout", "-q", "-b", "side");
    await handle.write("conflict.txt", "side change\n");
    await handle.commit("side");
    await handle.run("checkout", "-q", "main");
    await handle.write("conflict.txt", "main change\n");
    await handle.commit("main");
    // The merge is expected to fail with a conflict.
    await handle.run("merge", "side").catch(() => undefined);

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual([]);
    expect(codes(outcome)).toContain("W_UNMERGED_PATHS");
    const summary = outcome.changes.files.find(
      (f) => f.path === "conflict.txt",
    );
    // "unmerged" is index 0 of STATUS_PRECEDENCE, so it wins everywhere.
    expect(summary?.status).toBe("unmerged");
  });

  it("warns that submodules are not recursed into", async () => {
    const handle = await repo();
    await handle.write(".gitmodules", '[submodule "vendor"]\n\tpath = vendor\n');
    await handle.commit("declare a submodule");

    const outcome = await inspect(handle.dir);

    expect(codes(outcome)).toContain("W_SUBMODULE_UNINSPECTED");
  });
});

// ---------------------------------------------------------------------------
// Canonicalisation, truncation, scope selection
// ---------------------------------------------------------------------------

describe("result shaping", () => {
  it("reports the repository root even when a subdirectory is passed", async () => {
    const handle = await repo();
    await handle.write("nested/deep/file.txt", "x\n");
    await handle.commit("initial");
    await handle.write("nested/deep/new.txt", "y\n");

    const outcome = await inspect(`${handle.dir}/nested/deep`);

    expect(outcome.repository.path).toBe(handle.dir);
    // Paths stay repository-relative regardless of the entry point.
    expect(paths(outcome.changes.untracked)).toEqual(["nested/deep/new.txt"]);
  });

  it("truncates each scope but reports pre-truncation counts", async () => {
    const handle = await repo();
    await handle.write("seed.txt", "seed\n");
    await handle.commit("initial");
    for (let i = 1; i <= 5; i += 1) {
      await handle.write(`untracked-${i}.txt`, `${i}\n`);
    }

    const outcome = await inspect(handle.dir, { maxFilesPerScope: 2 });

    expect(outcome.changes.untracked).toHaveLength(2);
    expect(outcome.changes.files).toHaveLength(2);
    expect(outcome.changes.listTruncated).toBe(true);
    // The consumer must be able to see how much it is missing.
    expect(outcome.changes.counts.untracked).toBe(5);
    expect(outcome.changes.counts.distinctFiles).toBe(5);
    // Truncation keeps the byte-wise-first entries, deterministically.
    expect(paths(outcome.changes.untracked)).toEqual([
      "untracked-1.txt",
      "untracked-2.txt",
    ]);
  });

  it("computes only the requested scopes", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.run("checkout", "-q", "-b", "feature");
    await handle.write("committed.txt", "c\n");
    await handle.commit("feature");
    await handle.write("staged.txt", "s\n");
    await handle.run("add", "staged.txt");
    await handle.write("untracked.txt", "u\n");

    const outcome = await inspect(handle.dir, { scopes: ["staged"] });

    expect(paths(outcome.changes.staged)).toEqual(["staged.txt"]);
    expect(outcome.changes.committed).toEqual([]);
    expect(outcome.changes.untracked).toEqual([]);
    expect(outcome.changes.counts).toEqual({
      committed: 0,
      staged: 1,
      unstaged: 0,
      untracked: 0,
      distinctFiles: 1,
    });
  });

  it("sorts every list byte-wise", async () => {
    const handle = await repo();
    await handle.write("seed.txt", "seed\n");
    await handle.commit("initial");
    // Names must differ by more than case: macOS (APFS) and Windows are
    // case-insensitive, so "Apple.txt" and "apple.txt" would be the same file
    // and one write would silently clobber the other. These still prove the
    // point, because 'Z' (0x5A) must sort before 'b' (0x62) — the opposite of
    // what a locale-aware comparator produces.
    for (const name of ["Apple.txt", "Zebra.txt", "banana.txt", "cherry.txt"]) {
      await handle.write(name, "x\n");
    }

    const outcome = await inspect(handle.dir);

    expect(paths(outcome.changes.untracked)).toEqual([
      "Apple.txt",
      "Zebra.txt",
      "banana.txt",
      "cherry.txt",
    ]);
  });

  it("enumerates individual files inside an untracked directory", async () => {
    // Regression for `--untracked-files=normal`, which collapses the whole
    // subtree to a single `newdir/` entry — a directory path masquerading as a
    // ChangedFile, which the result contract does not allow.
    const handle = await repo();
    await handle.write("seed.txt", "seed\n");
    await handle.commit("initial");
    await handle.write("newdir/one.txt", "1\n");
    await handle.write("newdir/nested/two.txt", "2\n");

    const outcome = await inspect(handle.dir);

    expect(paths(outcome.changes.untracked)).toEqual([
      "newdir/nested/two.txt",
      "newdir/one.txt",
    ]);
    // No entry is a directory.
    for (const file of outcome.changes.untracked) {
      expect(file.path.endsWith("/")).toBe(false);
    }
    expect(outcome.changes.counts.untracked).toBe(2);
  });

  it("does not write .git/index while inspecting", async () => {
    // The MCP tool advertises `readOnlyHint: true`; that annotation drives
    // client auto-approval, so it has to be literally true. `git status` (and
    // a stat-dirty `git diff`) would normally rewrite the index as a refresh
    // optimisation — `--no-optional-locks` plus GIT_OPTIONAL_LOCKS=0 prevent it.
    const handle = await repo();
    await handle.write("tracked.txt", "one\n");
    await handle.commit("initial");
    await handle.write("untracked.txt", "two\n");
    // Make the index stat-dirty, which is exactly when git wants to rewrite it.
    await handle.write("tracked.txt", "one changed\n");
    const indexPath = path.join(handle.dir, ".git", "index");
    // A refresh only happens if the recorded stat looks stale, so age it.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(indexPath, past, past);
    const before = await fs.stat(indexPath);

    const outcome = await inspect(handle.dir);
    expect(fatals(outcome)).toEqual([]);

    const after = await fs.stat(indexPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});

// ---------------------------------------------------------------------------
// Argument injection
// ---------------------------------------------------------------------------

describe("argument injection through a caller-supplied base ref", () => {
  /**
   * An argv array stops shell injection and nothing else: Git still runs its
   * own option parser over every argument. Reproduced against the starter's
   * exact call shape, with no shell anywhere:
   *
   *   execFileSync("git", ["diff", "--name-status", `${base}...HEAD`])
   *
   * with base = "--output=/tmp/PWNED2.txt" created the file
   * /tmp/PWNED2.txt...HEAD on disk. Over MCP the base ref is model-chosen, so
   * that is an arbitrary file write selected by a model.
   *
   * The assertion that matters in each case below is the *absence of the
   * file*, not the error code.
   */
  async function expectNoWrite(
    baseRef: (target: string) => string,
  ): Promise<void> {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.run("checkout", "-q", "-b", "feature");
    await handle.write("b.txt", "two\n");
    await handle.commit("feature");

    // Inside the fixture's own temp root, so a successful attack is contained
    // and cleaned up, but still observable.
    const target = path.join(handle.root, "PWNED.txt");
    await expect(fs.stat(target)).rejects.toThrow();

    const outcome = await inspect(handle.dir, { baseRef: baseRef(target) });

    // The regression that matters: git never wrote the file.
    await expect(fs.stat(target)).rejects.toThrow();
    // ...and any near-miss variant of the name was not written either.
    const entries = await fs.readdir(handle.root);
    expect(entries.filter((e) => e.includes("PWNED"))).toEqual([]);

    expect(fatals(outcome)).toEqual(["E_BASE_REF_UNKNOWN"]);
    expect(outcome.changes.committed).toEqual([]);
  }

  it("refuses --output= and writes no file", async () => {
    await expectNoWrite((target) => `--output=${target}`);
  });

  it("refuses --output= even with the starter's ...HEAD suffix appended", async () => {
    await expectNoWrite((target) => `--output=${target}...HEAD`);
  });

  it("refuses --upload-pack=", async () => {
    await expectNoWrite((target) => `--upload-pack=touch ${target}`);
  });

  it("refuses a bare -O ordering-file style short option", async () => {
    await expectNoWrite((target) => `-O${target}`);
  });

  it("names the leading dash as the reason", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");

    const outcome = await inspect(handle.dir, { baseRef: "--output=/tmp/x" });

    expect(fatals(outcome)).toEqual(["E_BASE_REF_UNKNOWN"]);
    expect(outcome.diagnostics[0]?.message).toContain("begins with '-'");
    expect(outcome.diagnostics[0]?.hint).toContain("option");
  });

  it("refuses a ref containing control characters", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");

    const outcome = await inspect(handle.dir, { baseRef: "main\n--output=/tmp/x" });

    expect(fatals(outcome)).toEqual(["E_BASE_REF_UNKNOWN"]);
    expect(outcome.diagnostics[0]?.message).not.toContain("\n");
  });

  it("rejects range and revision trickery that does not name a single commit", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    await handle.write("b.txt", "two\n");
    await handle.commit("second");

    for (const hostile of ["HEAD~1..HEAD", "HEAD...HEAD", "HEAD^{tree}"]) {
      const outcome = await inspect(handle.dir, { baseRef: hostile });
      expect(fatals(outcome)).toEqual(["E_BASE_REF_UNKNOWN"]);
    }
  });

  /**
   * The tests above go through `inspectRepository`, where a hostile ref is
   * stopped by `assertSafeRef` and, failing that, by resolve-before-use: the
   * ref is validated with `rev-parse` before it is ever handed to `git diff`.
   * That layering means those tests do not, on their own, exercise the write
   * primitive — verified by disabling all three guards, after which they still
   * passed.
   *
   * These two go straight at `exec.ts` with the exact argv shape that does the
   * damage, so they fail the moment `--end-of-options` or the operand guard is
   * removed. Confirmed: with the sentinel deleted, `runGitRefs` below creates
   * the file.
   */
  it("runGitRefs neutralises an option smuggled into ref position", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    const target = path.join(handle.root, "PWNED-exec.txt");

    const result = await runGitRefs(
      handle.dir,
      ["diff", "--name-status"],
      [`--output=${target}`],
      20_000,
      { pathspecTerminator: true },
    );

    // Asserted first, and on its own: the non-creation of the file is the
    // regression that matters, so a failure must name it rather than naming
    // git's exit status.
    await expect(
      fs.stat(target),
      "git wrote an arbitrary file from a ref operand",
    ).rejects.toThrow();
    expect(result.ok).toBe(false);
  });

  it("runGit refuses to spawn at all when an operand looks like an option", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");
    const target = path.join(handle.root, "PWNED-raw.txt");

    // A hand-rolled argv that bypasses runGitRefs still cannot get through.
    const result = await runGit(
      handle.dir,
      ["diff", "--name-status", "--end-of-options", `--output=${target}`],
      20_000,
    );

    await expect(
      fs.stat(target),
      "git wrote an arbitrary file from a hand-rolled argv",
    ).rejects.toThrow();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toContain("refusing unsafe git operand");
  });

  it("still accepts a legitimate ref that resolves to a commit", async () => {
    // The guard must not be so blunt that it breaks ordinary usage.
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    const first = await handle.commit("initial");
    await handle.write("b.txt", "two\n");
    await handle.commit("second");

    const outcome = await inspect(handle.dir, { baseRef: "HEAD~1" });

    expect(fatals(outcome)).toEqual([]);
    expect(outcome.repository.base).toMatchObject({
      requested: "HEAD~1",
      ref: "HEAD~1",
      sha: first,
      mergeBase: first,
      autoDetected: false,
    });
    expect(paths(outcome.changes.committed)).toEqual(["b.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Fatal conditions: never thrown, always returned
// ---------------------------------------------------------------------------

describe("fatal conditions are returned, never thrown", () => {
  it("rejects an explicit base ref that does not resolve", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");

    const outcome = await inspect(handle.dir, { baseRef: "does-not-exist" });

    expect(fatals(outcome)).toEqual(["E_BASE_REF_UNKNOWN"]);
    expect(outcome.diagnostics[0]?.message).toContain("does-not-exist");
    expect(outcome.repository.base).toBeNull();
  });

  it("reports a plain directory as not a repository", async () => {
    const handle = await plainDir();
    await handle.write("readme.md", "not a repo\n");

    const outcome = await inspect(handle.dir);

    expect(fatals(outcome)).toEqual(["E_NOT_A_REPO"]);
    expect(outcome.diagnostics[0]?.message).toContain(handle.dir);
  });

  it("reports a path that does not exist as not a repository", async () => {
    const handle = await plainDir();
    const missing = `${handle.dir}/definitely missing`;

    const outcome = await inspect(missing);

    expect(fatals(outcome)).toEqual(["E_NOT_A_REPO"]);
    expect(outcome.diagnostics[0]?.message).toContain("does not exist");
  });

  it("reports a bare repository's git directory as having no work tree", async () => {
    const handle = await repo();
    await handle.write("a.txt", "one\n");
    await handle.commit("initial");

    const outcome = await inspect(`${handle.dir}/.git`);

    expect(fatals(outcome)).toEqual(["E_NOT_A_REPO"]);
  });

  it("resolves (never rejects) and returns a well-formed empty result on every fatal", async () => {
    const handle = await plainDir();
    const cases: Promise<InspectOutcome>[] = [
      inspect(handle.dir),
      inspect(`${handle.dir}/nope`),
    ];

    // The load-bearing assertion: a fatal is a value, not an exception.
    for (const pending of cases) {
      await expect(pending).resolves.toBeDefined();
      const outcome = await pending;
      expect(outcome.changes).toEqual({
        committed: [],
        staged: [],
        unstaged: [],
        untracked: [],
        files: [],
        counts: {
          committed: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          distinctFiles: 0,
        },
        listTruncated: false,
      });
      expect(outcome.repository.head).toEqual({
        unborn: false,
        detached: false,
        sha: null,
        branch: null,
      });
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.diagnostics[0]?.severity).toBe("fatal");
      // Never a serialised Error object or a multi-line git fatal.
      expect(outcome.diagnostics[0]?.message).not.toContain("\n");
    }
  });
});
