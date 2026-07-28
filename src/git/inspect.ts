/**
 * Repository inspection: turn a directory path into a `ChangeSet` plus the
 * provenance needed to interpret it.
 *
 * The contract that shapes every decision below: **`inspectRepository` never
 * rejects for an expected failure.** A missing directory, a bare repo, an
 * unresolvable base ref, unrelated histories — all of them return a well-formed
 * `InspectOutcome` carrying an empty `ChangeSet` and a `severity:"fatal"`
 * diagnostic. Only a genuine bug in this file escapes, and even that is caught
 * at the boundary and reported as `E_INTERNAL`.
 *
 * The second theme is **degrade, do not die**. A freshly `git init`ed
 * repository where an agent has just written ten files has no commits, no
 * branch history and no base ref — and is precisely the case that matters most.
 * It produces warnings and a populated untracked list, not an error.
 *
 * Only names and statuses are ever read. Diff *content* is never requested:
 * it is the single largest sink of an LLM's context window and nothing in the
 * result shape can carry it.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Diagnostic, DiagnosticCode } from "../core/errors.js";
import { describeError } from "../core/errors.js";
import { comparePaths } from "../core/text.js";
import type {
  ChangedFile,
  ChangeCounts,
  ChangeSet,
  FileStatus,
  FileSummary,
  HeadInfo,
  RepositoryInfo,
  ResolvedBase,
  Scope,
} from "../core/types.js";
import { SCOPES, STATUS_PRECEDENCE } from "../core/types.js";
import type { GitResult } from "./exec.js";
import { isSafeGitOperand, runGit, runGitRefs } from "./exec.js";
import { auditRepositoryConfig } from "./config-audit.js";
import { parseNameStatusZ, parsePorcelainZ } from "./parse.js";

export type InspectOptions = {
  /** Absolute, already canonicalised by the caller. */
  repositoryPath: string;
  /** Explicit base; absent means auto-detect. */
  baseRef?: string;
  /** Which of committed/staged/unstaged/untracked to compute. */
  scopes: Scope[];
  maxFilesPerScope: number;
  timeoutMs: number;
  /**
   * Skip the repository config audit, leaving repository-scoped executable keys
   * such as `filter.<n>.clean` live. Default false.
   *
   * `BASELINE_NEUTRALISED_KEYS` is unaffected: no value of this flag re-enables
   * `core.fsmonitor` or `diff.external`, because blanking those costs nothing
   * this tool needs and they are the two vectors with a time-of-check gap.
   *
   * Opting in is equivalent to trusting the repository, exactly like
   * `--allow-repo-config`. The MCP adapter never sets it: an agent's arguments
   * are influenced by repository text, so the repository must not be able to
   * talk its way into being trusted.
   */
  allowRepoExecConfig?: boolean;
};

export type InspectOutcome = {
  repository: RepositoryInfo;
  changes: ChangeSet;
  diagnostics: Diagnostic[];
};

/**
 * Base refs tried, in order, when the caller does not name one.
 *
 * `origin/HEAD` first because it is the only entry that reflects what the
 * *remote* actually considers its default branch; the rest are conventional
 * fallbacks. The starter hardcoded `main`, which broke on every repository
 * using `master`, `trunk`, `develop` or a fork with no `main` at all.
 */
const FALLBACK_BASE_REFS = [
  "origin/main",
  "origin/master",
  "main",
  "master",
] as const;

const PRECEDENCE_INDEX = new Map<FileStatus, number>(
  STATUS_PRECEDENCE.map((status, index) => [status, index]),
);

function emptyCounts(): ChangeCounts {
  return {
    committed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    distinctFiles: 0,
  };
}

function emptyChangeSet(): ChangeSet {
  return {
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
    files: [],
    counts: emptyCounts(),
    listTruncated: false,
  };
}

function unknownHead(): HeadInfo {
  return { unborn: false, detached: false, sha: null, branch: null };
}

function diagnostic(
  code: DiagnosticCode,
  severity: Diagnostic["severity"],
  message: string,
  hint?: string,
): Diagnostic {
  const value: Diagnostic = { code, severity, message };
  // exactOptionalPropertyTypes forbids assigning undefined to `hint?`.
  if (hint !== undefined) value.hint = hint;
  return value;
}

/** A single readable line: no newlines, no Error objects, bounded length. */
function oneLine(input: string): string {
  const collapsed = input.replace(/[\r\n]+/g, " ").trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed;
}

/**
 * Thrown internally to unwind to the boundary with a fatal diagnostic.
 *
 * A local control-flow device only — it is converted to an `InspectOutcome`
 * inside `inspectRepository` and never escapes the module.
 */
class FatalInspection extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diag: Diagnostic) {
    super(diag.message);
    this.name = "FatalInspection";
    this.diagnostic = diag;
  }
}

function fatal(
  code: DiagnosticCode,
  message: string,
  hint?: string,
): FatalInspection {
  return new FatalInspection(diagnostic(code, "fatal", message, hint));
}

/** Maps a failed `runGit` to the right fatal code, preserving timeouts. */
function gitFailure(
  result: Extract<GitResult, { ok: false }>,
  context: string,
): FatalInspection {
  if (result.code === "E_GIT_TIMEOUT") {
    return fatal(
      "E_GIT_TIMEOUT",
      `Git timed out while ${context}.`,
      "Raise the git timeout, or inspect a smaller repository.",
    );
  }
  return fatal(
    "E_GIT_FAILED",
    `Git failed while ${context}: ${oneLine(result.stderr)}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function inspectRepository(
  options: InspectOptions,
): Promise<InspectOutcome> {
  try {
    return await inspect(options);
  } catch (error) {
    if (error instanceof FatalInspection) {
      return {
        repository: {
          path: options.repositoryPath,
          head: unknownHead(),
          base: null,
        },
        changes: emptyChangeSet(),
        diagnostics: [error.diagnostic],
      };
    }
    // A genuine bug. Still a well-formed outcome: a caller embedding this in an
    // MCP server must not receive a stack trace instead of a result.
    return {
      repository: {
        path: options.repositoryPath,
        head: unknownHead(),
        base: null,
      },
      changes: emptyChangeSet(),
      diagnostics: [
        diagnostic(
          "E_INTERNAL",
          "fatal",
          `Unexpected inspection failure: ${oneLine(describeError(error))}`,
        ),
      ],
    };
  }
}

/**
 * Decides which repository-controlled config keys to blank for this inspection.
 *
 * Fails closed in both directions that matter: if the audit cannot run, the
 * inspection stops rather than proceeding with unknown configuration; if a
 * discovered key cannot be safely written as `-c <key>=`, the same. The only way
 * to run with these keys live is to ask for it explicitly on the CLI.
 */
async function resolveNeutralisedConfigKeys(
  options: InspectOptions,
  diagnostics: Diagnostic[],
): Promise<string[]> {
  if (options.allowRepoExecConfig === true) {
    diagnostics.push(
      diagnostic(
        "W_REPO_EXEC_CONFIG_TRUSTED",
        "warning",
        "Trusting the repository's own git configuration (--allow-repo-exec-config); repository-scoped keys such as filter.*.clean may execute during inspection. core.fsmonitor and diff.external stay disabled regardless of this flag.",
        "Drop the flag to inspect an untrusted repository without executing any of its configuration.",
      ),
    );
    return [];
  }

  const audit = await auditRepositoryConfig(
    options.repositoryPath,
    options.timeoutMs,
  );

  if (!audit.ok) {
    const error = audit.error;
    if (error !== undefined) throw gitFailure(error, "reading git configuration");
    throw fatal("E_GIT_FAILED", "Could not read the repository's git configuration.");
  }

  if (audit.unsafe.length > 0) {
    throw fatal(
      "E_REPO_EXEC_CONFIG",
      `Repository config sets ${audit.unsafe.length} executable key(s) that cannot be safely disabled: ${audit.unsafe.join(", ")}.`,
      "Remove the key from .git/config, or pass --allow-repo-exec-config if you trust this repository.",
    );
  }

  if (audit.neutralise.length > 0) {
    diagnostics.push(
      diagnostic(
        "W_REPO_EXEC_CONFIG_NEUTRALISED",
        "warning",
        `Disabled ${audit.neutralise.length} executable git config key(s) owned by this repository: ${audit.neutralise.join(", ")}.`,
        "These would otherwise run commands during inspection. If they are legitimate (git-lfs configured repository-locally, for example), pass --allow-repo-exec-config; reported paths may differ while they are disabled.",
      ),
    );
  }

  return audit.neutralise;
}

async function inspect(options: InspectOptions): Promise<InspectOutcome> {
  const { repositoryPath, timeoutMs } = options;
  const diagnostics: Diagnostic[] = [];

  /**
   * Repository-scoped config keys git would execute, blanked on every command
   * issued below. Populated at step 2a, once we know this is a work tree.
   *
   * Deliberately mutable and captured by the closures rather than resolved
   * first: the audit spawns git itself, so running it before the work-tree check
   * would report `E_GIT_FAILED` for a path that simply does not exist, when the
   * caller needs to hear `E_NOT_A_REPO`. Diagnosis precision and this defence
   * are both requirements, so the ordering has to satisfy both.
   */
  let neutralise: string[] = [];

  // Flag-only commands: no operand can appear, so nothing untrusted is passed.
  const git = (args: readonly string[]): Promise<GitResult> =>
    runGit(repositoryPath, args, timeoutMs, neutralise);

  // Commands that take ref operands. `flags` is always literal text authored
  // here; `refs` is the untrusted half and is placed after `--end-of-options`.
  const gitRefs = (
    flags: readonly string[],
    refs: readonly string[],
    pathspecTerminator = false,
  ): Promise<GitResult> =>
    runGitRefs(
      repositoryPath,
      flags,
      refs,
      timeoutMs,
      { pathspecTerminator },
      neutralise,
    );

  // --- 0. Reject a hostile base ref before it reaches any command ----------
  // An argv array prevents *shell* injection but not *argument* injection: git
  // still parses a caller-supplied "ref" of `--output=/tmp/x` as an option and
  // writes the file. This check happens before the ref is interpolated
  // anywhere, and `--end-of-options` in `runGitRefs` backs it up structurally.
  assertSafeRef(options.baseRef);

  // --- 1. Is this a Git work tree at all? ----------------------------------
  await assertDirectory(repositoryPath);

  const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok) {
    if (insideWorkTree.code === "E_GIT_TIMEOUT") {
      throw gitFailure(insideWorkTree, "checking for a Git work tree");
    }
    // A raw `fatal: not a git repository (or any of the parent directories)`
    // is what the starter printed. Say what we needed instead.
    throw fatal(
      "E_NOT_A_REPO",
      `Not a Git repository: ${repositoryPath}`,
      "Point the inspector at a directory inside a Git work tree.",
    );
  }
  if (insideWorkTree.stdout.trim() !== "true") {
    // `false` means we are inside a .git directory or a bare repository, where
    // there is no work tree and therefore no staged/unstaged/untracked reality.
    throw fatal(
      "E_NOT_A_REPO",
      `Path is inside a Git directory but has no work tree: ${repositoryPath}`,
      "Bare repositories cannot be inspected; use a checkout.",
    );
  }

  // --- 2. Canonical repository root ----------------------------------------
  const topLevel = await git(["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) throw gitFailure(topLevel, "resolving the repository root");
  // Resolving to the root (and realpath'ing it) makes the result identical no
  // matter which subdirectory the caller passed, and normalises the macOS
  // /tmp -> /private/tmp symlink so path comparisons are stable.
  // Git appends one record terminator. `trim()` would also remove legitimate
  // trailing spaces or tabs from the repository name, producing a nonexistent
  // cwd for validations.
  const rootPath = await realpathOr(topLevel.stdout.replace(/\r?\n$/, ""));

  // --- 2a. Disarm executable configuration the repository controls -----------
  // Placed here, and no later, because every remaining step is a potential
  // execution vector: `git status` consults `core.fsmonitor`, and `git diff`
  // consults a `filter.<n>.clean` driver named by an in-tree `.gitattributes`.
  //
  // Everything *above* is safe to have run un-audited, which is the load-bearing
  // claim of this placement: the only commands so far are `rev-parse
  // --is-inside-work-tree` and `rev-parse --show-toplevel`, and neither reads
  // the index or the work tree, so neither can trigger a filter or a monitor.
  // The two fixed-name baseline keys were pinned even for those.
  //
  // Reading configuration executes none of it, so the audit is itself safe.
  neutralise = await resolveNeutralisedConfigKeys(options, diagnostics);

  // --- 3. HEAD --------------------------------------------------------------
  const head = await resolveHead(git, diagnostics);

  // --- 4./5. Base ref and merge base ---------------------------------------
  const base = head.unborn
    ? null
    : await resolveBase(gitRefs, options, diagnostics);

  // --- 6. Scopes ------------------------------------------------------------
  const wanted = new Set<Scope>(options.scopes);
  const changes = await collectChanges(git, gitRefs, wanted, base, diagnostics);

  // --- 7. Submodules --------------------------------------------------------
  if (await exists(path.join(rootPath, ".gitmodules"))) {
    diagnostics.push(
      diagnostic(
        "W_SUBMODULE_UNINSPECTED",
        "warning",
        "Repository contains submodules; their contents were not inspected.",
        "A submodule appears as a single path. Inspect it separately if needed.",
      ),
    );
  }

  // --- 8./9. Summarise, sort, truncate -------------------------------------
  finaliseChangeSet(changes, options.maxFilesPerScope);

  const repository: RepositoryInfo = { path: rootPath, head, base };
  return { repository, changes, diagnostics };
}

// ---------------------------------------------------------------------------
// Step 0: ref safety
// ---------------------------------------------------------------------------

/**
 * Rejects a caller-supplied ref that Git's option parser would treat as a flag.
 *
 * Reproduced before this existed, with no shell involved:
 *
 *     execFileSync("git", ["diff", "--name-status", "--output=/tmp/PWNED2.txt...HEAD"])
 *
 * created `/tmp/PWNED2.txt...HEAD`. `--upload-pack=`, `--exec=` and friends are
 * the same shape. Because an MCP client lets a *model* choose the base ref,
 * this is an arbitrary file write chosen by a model, so it is rejected up
 * front with a specific message rather than being left to fail at resolution
 * time — resolution failure is not guaranteed for every option Git supports.
 */
function assertSafeRef(ref: string | undefined): void {
  if (ref === undefined || ref.length === 0) return;
  if (ref.startsWith("-")) {
    throw fatal(
      "E_BASE_REF_UNKNOWN",
      `Refusing base ref that begins with '-': ${oneLine(ref)}`,
      "A leading dash makes git parse the value as an option, not a revision.",
    );
  }
  if (!isSafeGitOperand(ref)) {
    throw fatal(
      "E_BASE_REF_UNKNOWN",
      `Refusing base ref containing control characters: ${JSON.stringify(ref).slice(0, 120)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 1: filesystem preconditions
// ---------------------------------------------------------------------------

async function assertDirectory(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Checked before spawning Git so a non-existent path produces a precise
    // message instead of a confusing `ENOENT` from the spawn itself.
    throw fatal(
      "E_NOT_A_REPO",
      code === "ENOENT"
        ? `Path does not exist: ${target}`
        : `Path is not readable: ${target} (${oneLine(describeError(error))})`,
    );
  }
  if (!stat.isDirectory()) {
    throw fatal("E_NOT_A_REPO", `Path is not a directory: ${target}`);
  }
}

async function realpathOr(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 3: HEAD
// ---------------------------------------------------------------------------

/** Runs a git command that takes no operands at all. */
type Git = (args: readonly string[]) => Promise<GitResult>;

/**
 * Runs a git command with ref operands, which are always placed after
 * `--end-of-options`. Every ref that originates outside this file must travel
 * through here; see `assertSafeRef`.
 */
type GitRefs = (
  flags: readonly string[],
  refs: readonly string[],
  pathspecTerminator?: boolean,
) => Promise<GitResult>;

async function resolveHead(
  git: Git,
  diagnostics: Diagnostic[],
): Promise<HeadInfo> {
  const revParse = await git(["rev-parse", "--verify", "-q", "HEAD"]);

  if (!revParse.ok) {
    if (revParse.code === "E_GIT_TIMEOUT") {
      throw gitFailure(revParse, "resolving HEAD");
    }
    // Unborn HEAD: `git init` with no commit yet. Not an error — it is the
    // state a repository is in when an agent has just scaffolded a project,
    // and the untracked list is the entire value of inspecting it.
    const branch = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
    diagnostics.push(
      diagnostic(
        "W_NO_COMMITS",
        "warning",
        "Repository has no commits yet; only working-tree changes were inspected.",
      ),
    );
    return {
      unborn: true,
      detached: false,
      sha: null,
      branch: branch.ok ? branch.stdout.trim() || null : null,
    };
  }

  const sha = revParse.stdout.trim();
  const symbolic = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (symbolic.ok) {
    return {
      unborn: false,
      detached: false,
      sha,
      branch: symbolic.stdout.trim(),
    };
  }
  if (symbolic.code === "E_GIT_TIMEOUT") {
    throw gitFailure(symbolic, "resolving the current branch");
  }

  diagnostics.push(
    diagnostic(
      "W_DETACHED_HEAD",
      "warning",
      "HEAD is detached; there is no current branch.",
    ),
  );
  return { unborn: false, detached: true, sha, branch: null };
}

// ---------------------------------------------------------------------------
// Steps 4 and 5: base ref and merge base
// ---------------------------------------------------------------------------

/** Resolves a ref to a commit SHA, or null if it does not name a commit. */
async function resolveCommit(
  git: GitRefs,
  ref: string,
): Promise<string | null> {
  // Defence in depth: even a ref that reached here without going through
  // assertSafeRef cannot be interpreted as an option.
  if (!isSafeGitOperand(ref)) return null;
  // `^{commit}` rejects a tag or tree that is not a commit, and `-q` keeps the
  // "needed a single revision" noise off stderr for the expected miss.
  const result = await git(
    ["rev-parse", "--verify", "-q"],
    [`${ref}^{commit}`],
  );
  if (!result.ok) {
    if (result.code === "E_GIT_TIMEOUT") {
      throw gitFailure(result, `resolving ref '${ref}'`);
    }
    return null;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

async function resolveBase(
  git: GitRefs,
  options: InspectOptions,
  diagnostics: Diagnostic[],
): Promise<ResolvedBase | null> {
  const requested = options.baseRef;

  let ref: string | null = null;
  let sha: string | null = null;
  let autoDetected = true;

  if (requested !== undefined && requested.length > 0) {
    autoDetected = false;
    sha = await resolveCommit(git, requested);
    if (sha === null) {
      // The caller asked for something specific. Silently substituting a
      // different base would produce a diff they did not ask for, so this is
      // one of the few conditions worth failing loudly on.
      throw fatal(
        "E_BASE_REF_UNKNOWN",
        `Base ref does not resolve to a commit: ${requested}`,
        "Check the ref name, or fetch the remote branch first.",
      );
    }
    ref = requested;
  } else {
    // `origin/HEAD` is a symbolic ref recording the remote's own default
    // branch, so it is tried first and dereferenced to a concrete name.
    const originHead = await git(
      ["symbolic-ref", "-q", "--short"],
      ["refs/remotes/origin/HEAD"],
    );
    const candidates: string[] = [];
    if (originHead.ok) {
      const name = originHead.stdout.trim();
      // Git's own output, but it still becomes an operand, so it is held to
      // the same rule as a caller-supplied ref.
      if (name.length > 0 && isSafeGitOperand(name)) candidates.push(name);
    } else if (originHead.code === "E_GIT_TIMEOUT") {
      throw gitFailure(originHead, "resolving origin/HEAD");
    }
    candidates.push(...FALLBACK_BASE_REFS);

    for (const candidate of candidates) {
      const resolved = await resolveCommit(git, candidate);
      if (resolved !== null) {
        ref = candidate;
        sha = resolved;
        break;
      }
    }
  }

  if (ref === null || sha === null) {
    // No base is a perfectly normal state: a brand-new repository with one
    // branch and no remote. Report the worktree scopes and say why the
    // committed scope is missing.
    diagnostics.push(
      diagnostic(
        "W_NO_BASE_REF",
        "warning",
        "No base ref could be auto-detected; the committed scope was skipped.",
        "Pass an explicit base ref (for example --base HEAD~1) to compare commits.",
      ),
    );
    return null;
  }

  // `merge-base` rejects a trailing `--`, so no pathspec terminator here.
  const mergeBaseResult = await git(["merge-base"], [sha, "HEAD"]);
  if (!mergeBaseResult.ok) {
    if (mergeBaseResult.code === "E_GIT_TIMEOUT") {
      throw gitFailure(mergeBaseResult, "computing the merge base");
    }
    // Unrelated histories. `git diff base...HEAD` would fail here too, but with
    // an opaque message; naming the two refs makes the cause obvious.
    throw fatal(
      "E_NO_MERGE_BASE",
      `No common ancestor between '${ref}' and HEAD; the histories are unrelated.`,
      "Choose a base ref that shares history with the current branch.",
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  if (mergeBase.length === 0) {
    throw fatal(
      "E_NO_MERGE_BASE",
      `No common ancestor between '${ref}' and HEAD; the histories are unrelated.`,
    );
  }

  return {
    requested: requested !== undefined && requested.length > 0 ? requested : null,
    ref,
    sha,
    mergeBase,
    autoDetected,
  };
}

// ---------------------------------------------------------------------------
// Step 6: scope collection
// ---------------------------------------------------------------------------

/**
 * Shared flags: detect renames and copies so a move is not an add + delete.
 *
 * `--no-ext-diff` and `--no-textconv` are security flags, not formatting ones.
 * Both `diff.external` and a `diff.<driver>.textconv` selected by an in-tree
 * `.gitattributes` name a command git runs, and `.gitattributes` is *tracked
 * content* — it survives `git clone`, unlike `.git/config`. These flags refuse
 * the behaviour outright rather than relying on the value having been blanked,
 * so the defence does not depend on the audit having seen the key.
 */
const DIFF_FLAGS = [
  "diff",
  "--name-status",
  "-z",
  "--find-renames",
  "--find-copies",
  "--no-ext-diff",
  "--no-textconv",
] as const;

async function collectChanges(
  git: Git,
  gitRefs: GitRefs,
  wanted: Set<Scope>,
  base: ResolvedBase | null,
  diagnostics: Diagnostic[],
): Promise<ChangeSet> {
  const changes = emptyChangeSet();

  if (wanted.has("committed") && base !== null) {
    // Explicit merge-base rather than `base...HEAD`: we already hold the SHA
    // for provenance, and a two-dot diff against it is unambiguous.
    const result = await gitRefs(DIFF_FLAGS, [base.mergeBase, "HEAD"], true);
    if (!result.ok) throw gitFailure(result, "diffing against the merge base");
    changes.committed = parseNameStatusZ(result.stdout);
  }

  if (wanted.has("staged")) {
    // Works even with an unborn HEAD, where Git compares against the empty
    // tree and every staged path shows as added.
    const result = await gitRefs([...DIFF_FLAGS, "--cached"], [], true);
    if (!result.ok) throw gitFailure(result, "diffing the index");
    changes.staged = parseNameStatusZ(result.stdout);
  }

  if (wanted.has("unstaged")) {
    const result = await gitRefs(DIFF_FLAGS, [], true);
    if (!result.ok) throw gitFailure(result, "diffing the working tree");
    changes.unstaged = parseNameStatusZ(result.stdout);
  }

  if (wanted.has("untracked") || wanted.has("unstaged")) {
    // `--untracked-files=all` is required, not merely preferred. With
    // `=normal` Git collapses an untracked directory into a single entry
    // ending in `/` (`docs/` rather than the files beneath it), which
    // under-reports whole subtrees. Embedded repositories remain opaque Git
    // directory markers even with `=all`; the parser labels those with
    // `kind: "directory"` rather than pretending they are files. The cost of
    // `all` is walking a large untracked tree, but output volume is already
    // bounded by `maxFilesPerScope`/`listTruncated` and wall-clock by
    // `timeoutMs`, so the bound is enforced where it belongs.
    //
    // No `--ignored` flag is passed, so `.gitignore`d paths never appear.
    const result = await git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (!result.ok) throw gitFailure(result, "listing working-tree status");
    const porcelain = parsePorcelainZ(result.stdout);

    if (wanted.has("untracked")) changes.untracked = porcelain.untracked;

    if (porcelain.unmerged.length > 0) {
      diagnostics.push(
        diagnostic(
          "W_UNMERGED_PATHS",
          "warning",
          `Repository has ${porcelain.unmerged.length} unmerged path(s) from an in-progress merge or rebase.`,
          "Resolve the conflicts before relying on this review.",
        ),
      );
      // A conflicted path is a working-tree fact, so it belongs to the
      // unstaged scope. `git diff` already reports most of them as `U`, so
      // only paths it missed (for example `DD`) are appended.
      if (wanted.has("unstaged")) {
        const seen = new Set(changes.unstaged.map((file) => file.path));
        for (const file of porcelain.unmerged) {
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          changes.unstaged.push(file);
        }
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Steps 8 and 9: summary, ordering, truncation
// ---------------------------------------------------------------------------

function precedenceOf(status: FileStatus): number {
  return PRECEDENCE_INDEX.get(status) ?? STATUS_PRECEDENCE.length;
}

function sortFiles<T extends { path: string }>(files: T[]): void {
  // Byte-wise, not localeCompare: locale ordering differs between machines and
  // would make the CLI/MCP consistency comparison flaky.
  files.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Mutates `changes` in place: builds the per-path summary, sorts everything,
 * records pre-truncation counts, then applies the cap.
 *
 * Counts are captured *before* truncation on purpose. A consumer that sees
 * `untracked: 5000` with a 50-entry list knows exactly how much it is missing;
 * counts that matched the truncated list would hide the elision.
 */
function finaliseChangeSet(changes: ChangeSet, maxFilesPerScope: number): void {
  for (const scope of SCOPES) sortFiles(changes[scope]);

  // One row per distinct path, unioned across scopes.
  type Accumulator = {
    path: string;
    status: FileStatus;
    scopes: Scope[];
    kind?: "directory";
  };
  const byPath = new Map<string, Accumulator>();

  // SCOPES order is committed, staged, unstaged, untracked, so the `scopes`
  // array on each summary is in that canonical order without extra sorting.
  for (const scope of SCOPES) {
    for (const file of changes[scope]) {
      const existing = byPath.get(file.path);
      if (existing === undefined) {
        byPath.set(file.path, {
          path: file.path,
          status: file.status,
          scopes: [scope],
          ...(file.kind === "directory" ? { kind: "directory" as const } : {}),
        });
        continue;
      }
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
      // Lower index wins: worktree reality beats history.
      if (precedenceOf(file.status) < precedenceOf(existing.status)) {
        existing.status = file.status;
      }
    }
  }

  const files: FileSummary[] = [...byPath.values()];
  sortFiles(files);

  changes.counts = {
    committed: changes.committed.length,
    staged: changes.staged.length,
    unstaged: changes.unstaged.length,
    untracked: changes.untracked.length,
    distinctFiles: files.length,
  };

  const cap = Math.max(0, maxFilesPerScope);
  let truncated = false;

  const clip = <T>(list: T[]): T[] => {
    if (list.length <= cap) return list;
    truncated = true;
    return list.slice(0, cap);
  };

  changes.committed = clip<ChangedFile>(changes.committed);
  changes.staged = clip<ChangedFile>(changes.staged);
  changes.unstaged = clip<ChangedFile>(changes.unstaged);
  changes.untracked = clip<ChangedFile>(changes.untracked);
  changes.files = clip<FileSummary>(files);
  changes.listTruncated = truncated;
}
