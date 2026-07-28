/**
 * Regressions for repository-controlled *executable git configuration*.
 *
 * This is the vulnerability class the first version of this tool shipped with.
 * `git` runs commands named by its own config, and config travels with a
 * repository directory — so pointing the "read-only" inspector at a repository
 * someone else assembled executed their code. The MCP `inspect_repository` tool
 * is annotated `readOnlyHint: true`, and clients use that annotation to
 * auto-approve calls without asking a human, which is what made this serious
 * rather than merely untidy.
 *
 * ## How these tests avoid passing for the wrong reason
 *
 * An earlier argument-injection test in this repository stayed green after its
 * defence was disabled, because an unrelated check rejected the input first.
 * Two habits guard against a repeat:
 *
 *  1. **A side-effect oracle.** Each vector points git at a probe script that
 *     creates a marker file. "The marker does not exist" can only hold if the
 *     command genuinely never ran.
 *
 *  2. **An armed/disarmed pair.** Every "blocked" assertion has a sibling that
 *     runs the identical fixture with the defence disabled and asserts the
 *     marker *does* appear. A refactor that makes the vector unreachable for an
 *     unrelated reason turns the sibling red, so a vacuous pass is visible.
 *
 * The first draft of this file failed exactly that way and it is worth
 * recording: the probe lived under the fixture's work tree, whose path contains
 * a space on purpose, and git splits a config command on whitespace — so nothing
 * executed and three "blocked" assertions were passing for free. Probes now live
 * in a space-free directory of their own.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditRepositoryConfig,
  isExecutableConfigKey,
  parseConfigScopeZ,
} from "../../src/git/config-audit.js";
import {
  BASELINE_NEUTRALISED_KEYS,
  configOverrideArgs,
  isSafeConfigKey,
} from "../../src/git/exec.js";
import { inspectRepository } from "../../src/git/inspect.js";
import { makeRepo, type RepoHandle } from "../helpers/repo.js";

const TIMEOUT_MS = 30_000;

let repos: RepoHandle[] = [];
let probeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  await Promise.all(
    probeDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  repos = [];
  probeDirs = [];
});

type Probe = {
  repo: RepoHandle;
  /** Path to a script git will execute. Contains no whitespace. */
  fsmonitor: string;
  /** Path to a script usable as a clean filter. Contains no whitespace. */
  filter: string;
  executed: () => Promise<boolean>;
  reset: () => Promise<void>;
};

/**
 * A repository with one commit and one stat-dirty tracked file, plus probe
 * scripts that record having run.
 *
 * The work tree keeps a space in its path (that is what `makeRepo` is for), but
 * the probes deliberately do not: git treats a config command as a command
 * *line*, so a probe under a spaced path would silently never execute and every
 * assertion below would pass for the wrong reason.
 */
async function makeProbeRepo(): Promise<Probe> {
  const repo = await makeRepo("hostile config");
  repos.push(repo);

  await repo.write("tracked.txt", "original\n");
  await repo.commit("init");
  // Stat-dirty: forces `git diff` to compare content, which is what makes it
  // consult a clean filter at all.
  await repo.write("tracked.txt", "modified\n");

  const probeDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "inspector-probe-")),
  );
  probeDirs.push(probeDir);

  const marker = path.join(probeDir, "EXECUTED.marker");
  const fsmonitor = path.join(probeDir, "fsmonitor.sh");
  const filter = path.join(probeDir, "filter.sh");

  // Exits non-zero so git abandons the fsmonitor protocol and falls back to a
  // normal scan. A probe that exits 0 without speaking the protocol makes git
  // wait for a reply that never comes, and the test hangs instead of failing.
  await fs.writeFile(
    fsmonitor,
    `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`,
    "utf8",
  );
  // A clean filter must pass content through on stdout, or git reports a filter
  // error rather than quietly running it.
  await fs.writeFile(
    filter,
    `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`,
    "utf8",
  );
  await fs.chmod(fsmonitor, 0o755);
  await fs.chmod(filter, 0o755);

  return {
    repo,
    fsmonitor,
    filter,
    executed: () =>
      fs
        .access(marker)
        .then(() => true)
        .catch(() => false),
    reset: () => fs.rm(marker, { force: true }),
  };
}

function inspect(repositoryPath: string, allowRepoExecConfig = false) {
  return inspectRepository({
    repositoryPath,
    scopes: ["committed", "staged", "unstaged", "untracked"],
    maxFilesPerScope: 500,
    timeoutMs: TIMEOUT_MS,
    ...(allowRepoExecConfig ? { allowRepoExecConfig: true } : {}),
  });
}

describe("core.fsmonitor (executes during git status)", () => {
  it("armed: raw git runs it, proving the fixture is wired up", async () => {
    const probe = await makeProbeRepo();
    await probe.repo.run("config", "core.fsmonitor", probe.fsmonitor);

    await probe.repo.run("status", "--porcelain").catch(() => "");

    expect(await probe.executed()).toBe(true);
  });

  it("disarmed: inspection does not run it", async () => {
    const probe = await makeProbeRepo();
    await probe.repo.run("config", "core.fsmonitor", probe.fsmonitor);

    const outcome = await inspect(probe.repo.dir);

    expect(await probe.executed()).toBe(false);
    expect(outcome.diagnostics.map((d) => d.code)).toContain(
      "W_REPO_EXEC_CONFIG_NEUTRALISED",
    );
  });

  it("stays disabled even under --allow-repo-exec-config", async () => {
    const probe = await makeProbeRepo();
    await probe.repo.run("config", "core.fsmonitor", probe.fsmonitor);

    await inspect(probe.repo.dir, true);

    // Pinned unconditionally: the baseline keys have fixed names, so they need
    // no audit and therefore have no time-of-check/time-of-use gap. The help
    // text and the W_REPO_EXEC_CONFIG_TRUSTED message both promise this.
    expect(BASELINE_NEUTRALISED_KEYS).toContain("core.fsmonitor");
    expect(await probe.executed()).toBe(false);
  });
});

describe("filter.<name>.clean (executes during git diff)", () => {
  /**
   * `.gitattributes` is *tracked content*, so this half of the vector survives
   * `git clone` — it is not limited to directories handed over wholesale.
   */
  async function withHostileFilter(): Promise<Probe> {
    const probe = await makeProbeRepo();
    await probe.repo.write(".gitattributes", "tracked.txt filter=evil\n");
    await probe.repo.run("config", "filter.evil.clean", probe.filter);
    return probe;
  }

  it("armed: runs when the repository's config is trusted", async () => {
    const probe = await withHostileFilter();

    const outcome = await inspect(probe.repo.dir, true);

    // This is the negative control for the test below. If this ever goes green
    // in the other direction, the "disarmed" assertion has become vacuous.
    expect(await probe.executed()).toBe(true);
    expect(outcome.diagnostics.map((d) => d.code)).toContain(
      "W_REPO_EXEC_CONFIG_TRUSTED",
    );
  });

  it("disarmed: inspection does not run it, and names it in a warning", async () => {
    const probe = await withHostileFilter();

    const outcome = await inspect(probe.repo.dir);

    expect(await probe.executed()).toBe(false);
    const warning = outcome.diagnostics.find(
      (d) => d.code === "W_REPO_EXEC_CONFIG_NEUTRALISED",
    );
    expect(warning?.message).toContain("filter.evil.clean");
  });

  it("still reports the correct changed paths while disarmed", async () => {
    const probe = await withHostileFilter();

    // Security that silently changes the answer is its own defect.
    const outcome = await inspect(probe.repo.dir);

    expect(outcome.changes.unstaged.map((f) => f.path)).toContain("tracked.txt");
    expect(outcome.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
  });
});

describe("include.path indirection", () => {
  it("finds keys that --list --local does not resolve", async () => {
    const probe = await makeProbeRepo();
    await fs.writeFile(
      path.join(probe.repo.dir, ".git", "included.cfg"),
      `[core]\n\tfsmonitor = ${probe.fsmonitor}\n` +
        `[filter "sneaky"]\n\tclean = ${probe.filter}\n`,
      "utf8",
    );
    await probe.repo.run("config", "include.path", "./included.cfg");

    // The trap this test exists for: an audit built on `--list --local` reports
    // this repository as clean while both keys still execute.
    const local = await probe.repo.run("config", "--list", "--local");
    expect(local).not.toContain("fsmonitor");

    const audit = await auditRepositoryConfig(probe.repo.dir, TIMEOUT_MS);
    expect(audit.neutralise).toContain("core.fsmonitor");
    expect(audit.neutralise).toContain("filter.sneaky.clean");

    await inspect(probe.repo.dir);
    expect(await probe.executed()).toBe(false);
  });
});

describe("fail-closed and scope rules", () => {
  it("refuses an executable key that cannot be expressed as -c key=", async () => {
    const probe = await makeProbeRepo();
    const configPath = path.join(probe.repo.dir, ".git", "config");
    // A subsection containing a space cannot be written back as `-c <key>=`.
    // Skipping it silently would leave it live while reporting success.
    const existing = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      `${existing}[filter "has space"]\n\tclean = ${probe.filter}\n`,
      "utf8",
    );

    const outcome = await inspect(probe.repo.dir);

    expect(await probe.executed()).toBe(false);
    const fatal = outcome.diagnostics.find((d) => d.severity === "fatal");
    expect(fatal?.code).toBe("E_REPO_EXEC_CONFIG");
    expect(fatal?.message).toContain("has space");
  });

  it("leaves global-scope filters alone so git-lfs keeps working", async () => {
    const probe = await makeProbeRepo();
    // Only `local` and `worktree` scope travel with a repository. `git-lfs`
    // configures `filter.lfs.clean` globally for real developers; blanking that
    // would corrupt reported paths for every LFS repository and buy nothing,
    // because global config belongs to the already-trusted operator.
    const audit = await auditRepositoryConfig(probe.repo.dir, TIMEOUT_MS);

    expect(audit.ok).toBe(true);
    expect(audit.neutralise).toEqual([]);
  });
});

describe("argv construction", () => {
  it("emits -c key= overrides, which outrank every config file", () => {
    // Asserted at the argv layer as well as behaviourally: a refactor that drops
    // the override should fail here with an obvious message, not only as a
    // mysteriously executed probe somewhere else.
    expect(configOverrideArgs(["core.fsmonitor", "filter.x.clean"])).toEqual([
      "-c",
      "core.fsmonitor=",
      "-c",
      "filter.x.clean=",
    ]);
    expect(configOverrideArgs(BASELINE_NEUTRALISED_KEYS)).toContain(
      "core.fsmonitor=",
    );
  });

  it("rejects config keys that could break out of -c key=", () => {
    for (const key of ["core.fsmonitor", "filter.lfs.clean", "diff.a-b.textconv"]) {
      expect(isSafeConfigKey(key), key).toBe(true);
    }
    for (const key of [
      "--upload-pack=x",
      "filter.has space.clean",
      "core.fsmonitor=x",
      "core.\nfsmonitor",
      "",
    ]) {
      expect(isSafeConfigKey(key), key).toBe(false);
    }
  });
});

describe("config audit parsing", () => {
  it("parses the scope/key/value framing of --list -z --show-scope", () => {
    // Not the obvious layout: two NUL-terminated fields per entry, with the key
    // and value separated by a newline *inside* the second field. A valueless
    // key has no newline at all.
    const stdout =
      "local\0core.bare\nfalse\0" +
      "global\0filter.lfs.clean\ngit-lfs clean -- %f\0" +
      "local\0include.path\0";

    expect(parseConfigScopeZ(stdout)).toEqual([
      { scope: "local", key: "core.bare" },
      { scope: "global", key: "filter.lfs.clean" },
      { scope: "local", key: "include.path" },
    ]);
  });

  it("recognises executable keys including attacker-named driver families", () => {
    for (const key of [
      "core.fsmonitor",
      "core.hooksPath",
      "diff.external",
      "filter.anything.clean",
      "filter.x.process",
      "diff.y.textconv",
      "merge.z.driver",
      "CORE.FSMONITOR",
    ]) {
      expect(isExecutableConfigKey(key), key).toBe(true);
    }

    for (const key of [
      "core.bare",
      "user.name",
      "include.path",
      "filter.lfs.required",
      "diff.renames",
    ]) {
      expect(isExecutableConfigKey(key), key).toBe(false);
    }
  });
});
