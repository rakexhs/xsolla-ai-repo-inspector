/**
 * Finds executable configuration that the *inspected repository* controls.
 *
 * ## Why this module exists
 *
 * The tool's central claim is that inspection executes nothing: the MCP
 * `inspect_repository` tool is annotated `readOnlyHint: true`, and clients use
 * that annotation to auto-approve calls without asking a human. The first
 * version of this tool made that claim while it was false.
 *
 * `git` executes commands named by its own configuration, and configuration is
 * *repository content*: `.git/config` arrives with the directory you were
 * handed — an unpacked archive, a CI artifact, a mounted workspace, a vendored
 * tree. Three vectors were reproduced end-to-end against the previous version:
 *
 *   1. `core.fsmonitor = ./evil.sh`      -> runs during `git status`
 *   2. `filter.<name>.clean = ./evil.sh` -> runs during `git diff`, selected by
 *                                           an in-tree `.gitattributes`
 *   3. the same keys behind `include.path = ./sneaky.cfg`
 *
 * None of that involves a shell, and none of it is stopped by the argv arrays,
 * the `--end-of-options` sentinel, or the validation allowlist. It is the same
 * confused-deputy problem the allowlist exists to solve, one layer lower down:
 * the repository was allowed to choose a command.
 *
 * ## Why an audit rather than a fixed blocklist
 *
 * Two of the vectors have fixed key names and are pinned unconditionally in
 * `./exec.ts`. Filter and textconv drivers cannot be: the driver *name* is
 * chosen by the attacker (`filter.hidden.clean`), so there is no fixed key to
 * blank. They have to be discovered before they can be neutralised.
 *
 * ## Why scope matters
 *
 * `git-lfs` legitimately configures `filter.lfs.clean` in a developer's
 * **global** config. Blanking that would silently corrupt what this tool
 * reports for every LFS repository, in the name of security it does not buy —
 * global config is the operator's own, and the operator is already trusted.
 * Only `local` and `worktree` scope travel with the repository, so only those
 * are neutralised.
 *
 * ## Why `--show-scope` and not `--list --local`
 *
 * `git config --list --local` does **not** resolve `include.path`. An audit
 * built on it reports a clean repository while the included `core.fsmonitor`
 * still executes — a check that passes for the wrong reason. `--list
 * --show-scope` resolves includes *and* attributes each resulting key to the
 * scope of the file that pulled it in, which is exactly the question being
 * asked. Verified against git 2.50.1.
 */
import { isSafeConfigKey, runGit, type GitResult } from "./exec.js";

/**
 * Scopes that arrive with the repository. `global` and `system` belong to the
 * operator; `command` is us. `unknown` is git's label for values that came from
 * the environment, which is also ours.
 */
const UNTRUSTED_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);

/**
 * Fixed-name keys whose value git executes.
 *
 * Wider than the set reachable from the subcommands used today, on purpose: a
 * future call site that adds `git fetch` or `git merge` should not silently
 * reopen a hole. Blanking a key that is never consulted costs nothing.
 */
const EXEC_KEYS: ReadonlySet<string> = new Set([
  "core.fsmonitor",
  "core.hookspath",
  "core.sshcommand",
  "core.gitproxy",
  "core.askpass",
  "core.editor",
  "core.pager",
  "core.alternaterefscommand",
  "diff.external",
  "credential.helper",
  "gpg.program",
  "init.templatedir",
  "sequence.editor",
  "uploadpack.packobjectshook",
]);

/**
 * Families where the middle component is an attacker-chosen driver name, so the
 * key can only be found by enumeration.
 */
const EXEC_KEY_PATTERNS: readonly RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^credential\..+\.helper$/,
];

export function isExecutableConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (EXEC_KEYS.has(lower)) return true;
  return EXEC_KEY_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Parses `git config --list -z --show-scope`.
 *
 * The record layout is *not* the obvious one, which is why it gets its own
 * exported function and its own unit test. Each entry is two NUL-terminated
 * fields — scope, then `key\nvalue` — and a valueless key has no newline at
 * all:
 *
 *     "local\0core.bare\nfalse\0local\0include.path\0"
 */
export function parseConfigScopeZ(
  stdout: string,
): { scope: string; key: string }[] {
  const entries: { scope: string; key: string }[] = [];
  // A trailing NUL yields one empty field; filtering keeps the pairing intact.
  const fields = stdout.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    const keyAndValue = fields[i + 1];
    if (scope === undefined || keyAndValue === undefined) continue;
    const newline = keyAndValue.indexOf("\n");
    const key = newline === -1 ? keyAndValue : keyAndValue.slice(0, newline);
    if (key.length === 0) continue;
    entries.push({ scope, key });
  }
  return entries;
}

export type ConfigAudit = {
  /** Repository-scoped executable keys that will be blanked. Sorted, unique. */
  neutralise: string[];
  /**
   * Executable keys that cannot be safely expressed as `-c <key>=`. Non-empty
   * means the inspection must fail closed rather than proceed with them live.
   */
  unsafe: string[];
  /** False when git could not be queried; callers must then fail closed. */
  ok: boolean;
  /** Present when `ok` is false. */
  error?: Extract<GitResult, { ok: false }>;
};

/**
 * Lists the repository's effective configuration and reports the executable,
 * repository-controlled part of it.
 *
 * Reading configuration does not execute any of it, so this call is safe to make
 * before the defences it informs are in place.
 */
export async function auditRepositoryConfig(
  repositoryPath: string,
  timeoutMs: number,
): Promise<ConfigAudit> {
  const result = await runGit(
    repositoryPath,
    ["config", "--list", "-z", "--show-scope"],
    timeoutMs,
  );

  if (!result.ok) {
    return { neutralise: [], unsafe: [], ok: false, error: result };
  }

  const neutralise = new Set<string>();
  const unsafe = new Set<string>();

  for (const { scope, key } of parseConfigScopeZ(result.stdout)) {
    if (!UNTRUSTED_SCOPES.has(scope)) continue;
    if (!isExecutableConfigKey(key)) continue;
    if (isSafeConfigKey(key)) neutralise.add(key);
    else unsafe.add(key);
  }

  return {
    neutralise: [...neutralise].sort(),
    unsafe: [...unsafe].sort(),
    ok: true,
  };
}
