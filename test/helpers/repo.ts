/**
 * Real-repository fixture builder.
 *
 * These tests drive actual `git` processes against actual temp directories
 * rather than mocking `child_process`. A mock would happily agree with whatever
 * the parser expects, which is exactly the class of bug being hunted here
 * (rename pairing order, NUL framing, paths with spaces). Repos are small and
 * local, so the cost is a few hundred milliseconds.
 *
 * Every commit is pinned to a fixed identity and timestamp so SHAs and ordering
 * are reproducible run to run.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FIXED_DATE = "2024-01-01T00:00:00+0000";

/**
 * Deterministic, minimal environment for fixture Git commands.
 *
 * The same scrubbing rationale as `src/git/exec.ts`: the developer's own
 * `~/.gitconfig` must not decide whether a fixture has a `main` branch, a
 * commit signature, or a rename threshold.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture Author",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture Author",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
  if (process.env["PATH"] !== undefined) env["PATH"] = process.env["PATH"];
  if (process.env["HOME"] !== undefined) env["HOME"] = process.env["HOME"];
  return env;
}

export type RepoHandle = {
  /** Absolute path to the work tree (realpath'd). */
  dir: string;
  /** The temp directory containing `dir`; removed by `cleanup`. */
  root: string;
  /** Writes a file, creating parent directories. */
  write(relPath: string, contents: string): Promise<void>;
  /** Removes a file from the work tree. */
  remove(relPath: string): Promise<void>;
  /** Runs `git <args>` in the work tree. Rejects on non-zero exit. */
  run(...args: string[]): Promise<string>;
  /** `git add -A` then commit with a fixed identity. */
  commit(message: string): Promise<string>;
  cleanup(): Promise<void>;
};

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: fixture paths deliberately contain spaces and newlines.
    execFile(
      "git",
      args,
      { cwd, env: fixtureEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Creates an initialised repository inside a fresh temp directory.
 *
 * `name` becomes the work-tree directory name inside the temp root, so a caller
 * can force a path containing a space (`makeRepo("has space")`) to regress the
 * starter's shell-interpolation bug.
 */
export async function makeRepo(name = "repo"): Promise<RepoHandle> {
  // mkdtemp prefix contains a space: every fixture therefore exercises a path
  // that a shell-interpolating implementation would split.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspector- test-"));
  // realpath because macOS makes /tmp a symlink to /private/tmp, and
  // `git rev-parse --show-toplevel` reports the resolved form.
  const realRoot = await fs.realpath(root);
  const dir = path.join(realRoot, name);
  await fs.mkdir(dir, { recursive: true });

  // -c init.defaultBranch=main: the default is a warning-emitting,
  // version-dependent value, and several tests depend on the branch name.
  await execGit(dir, ["-c", "init.defaultBranch=main", "init", "-q", "."]);
  await execGit(dir, ["config", "user.name", "Fixture Author"]);
  await execGit(dir, ["config", "user.email", "fixture@example.invalid"]);
  await execGit(dir, ["config", "commit.gpgsign", "false"]);

  const handle: RepoHandle = {
    dir,
    root: realRoot,
    async write(relPath, contents) {
      const target = path.join(dir, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    },
    async remove(relPath) {
      await fs.rm(path.join(dir, relPath), { force: true });
    },
    async run(...args) {
      return execGit(dir, args);
    },
    async commit(message) {
      await execGit(dir, ["add", "-A"]);
      await execGit(dir, ["commit", "-q", "-m", message]);
      return (await execGit(dir, ["rev-parse", "HEAD"])).trim();
    },
    async cleanup() {
      // force + recursive so a half-built fixture never fails teardown, and
      // never throws out of an afterEach.
      await fs.rm(realRoot, { recursive: true, force: true }).catch(() => {});
    },
  };

  return handle;
}

/** Creates a plain directory (not a repository) for negative tests. */
export async function makePlainDir(name = "plain"): Promise<RepoHandle> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspector- test-"));
  const realRoot = await fs.realpath(root);
  const dir = path.join(realRoot, name);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    root: realRoot,
    async write(relPath, contents) {
      const target = path.join(dir, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    },
    async remove(relPath) {
      await fs.rm(path.join(dir, relPath), { force: true });
    },
    async run() {
      throw new Error("not a repository");
    },
    async commit() {
      throw new Error("not a repository");
    },
    async cleanup() {
      await fs.rm(realRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
