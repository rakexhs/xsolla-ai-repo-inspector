# Submission

## Read this first: three things worth your time

1. **`--base-ref "--output=/tmp/x"` was an arbitrary-file-write primitive.** An
   argv array stops *shell* injection and nothing else; git still parses a
   caller-supplied ref with its own option parser. Reachable from both the CLI
   and, more seriously, from a model over MCP.
2. **A repository's own `.git/config` executed code during "read-only"
   inspection.** `core.fsmonitor` runs during `git status`; a
   `filter.<name>.clean` driver selected by an in-tree `.gitattributes` runs
   during `git diff`. The validation allowlist never saw them, because *git* was
   the process executing. I found this **after** I had already written the
   trust-boundary section claiming the tool executed nothing — it is my own bug,
   in my own threat model, one layer below where I had been looking.
3. **A security test that passed for the wrong reason — twice.** Once in the
   original work, once while fixing item 2. Both are documented below, because
   how a green test lies is more useful than the fact that it went green.

## Defect → fix → regression

Because this is a rewrite rather than a patch series, a diff will not tell you
which starter defect maps to which fix. This table is that map. Every row's
regression fails if you revert the fix.

| # | Starter defect | Where it lived | Fix | Regression |
|---|---|---|---|---|
| 1 | `build` exits 0 while `package.json#bin` points at a file the build never emits (`dist/cli.js`; `rootDir: "."` puts it at `dist/src/cli.js`) | `package.json`, `tsconfig.json` | `scripts/postbuild.mjs` fails when a declared bin is absent | `test/packaging/tarball.test.ts` — packs, installs into a clean project, runs the installed binary |
| 2 | Tests compiled into the published output tree | `tsconfig.json` `include` | Split `tsconfig.json` / `tsconfig.test.json` | same as #1 (`files` + tarball contents) |
| 3 | `--repo` silently truncated at the first space (`argv[++index]?.split(" ")[0]`) | `src/cli.ts:18` | Real tokeniser | `test/cli/args.test.ts`; every fixture path contains a space by construction |
| 4 | Validations run through a shell (`exec(command)`) | `src/validation.ts:6` | `spawn` from an argv array, no shell anywhere | `test/unit/tokenize.test.ts`, `test/adversarial/validation-hostile.test.ts` |
| 5 | Only a committed diff reported; staged, unstaged and untracked changes invisible | `src/git.ts` | Four disjoint scopes plus a deduplicated union | `test/integration/git-inspect.test.ts` |
| 6 | `--format json` accepted and ignored (`report.ts` had no JSON path at all) | `src/report.ts` | `src/render/json.ts` as the single serialisation path | `test/unit/render-json.test.ts`, `test/consistency/cli-mcp-parity.test.ts` |
| 7 | A failing `--validate` aborted the whole review | `src/validation.ts` | Non-zero exit is data on a `ValidationOutcome` | `test/integration/validation-run.test.ts` |
| 8 | Unresolvable `--base-ref` and missing flag values could exit 0 | `src/cli.ts` | One exit-code map in `src/core/errors.ts` | `test/cli/cli-subprocess.test.ts` (asserts real `{stdout, stderr, code}`) |
| 9 | Base ref hardcoded to `main` | `src/git.ts` | `FALLBACK_BASE_REFS`, then a warning | `test/integration/git-inspect.test.ts` (no `main`, detached, unborn, unrelated histories) |
| 10 | MCP schema advertised `repo_path`; handler read `input.repoPath`, so it was always `undefined` and the server inspected its own cwd | `src/mcp-server.ts:13` vs `:19` | Schema and handler derive from one Zod source | `test/mcp/contract.test.ts` |
| 11 | Transport connected at module load, so the surface could not be tested without stdio | `src/mcp-server.ts:27` | `createServer()` builds without connecting | `test/mcp/*` over `InMemoryTransport` |
| 12 | MCP accepted caller-supplied validation commands with no allowlist | `src/mcp-server.ts` | No command-string field exists in the MCP schema | `test/mcp/security.test.ts` |
| 13 | **Argument injection:** `--base-ref "--output=/tmp/x"` writes that file | `src/git.ts` (argv array, still vulnerable) | Reject leading `-`, `rev-parse --verify` caller refs, `--end-of-options` before operands | `test/adversarial/git-hostile.test.ts` — asserts at the argv layer, not just non-creation |
| 14 | **Repository-controlled config execution** (found in my own rewrite) | `.git/config` → `git status` / `git diff` | Pin `core.fsmonitor`/`diff.external`; audit and blank repo-scoped driver keys; `--no-ext-diff --no-textconv` | `test/adversarial/git-config-exec.test.ts`, `test/mcp/security.test.ts` — armed/disarmed pairs |
| 15 | Docs promised a `--config ./inspector.config.json` that was never committed, and allowlisted a `lint` script that does not exist (**my defect, not the starter's**) | `README.md` | Committed a working `inspector.config.json` | `test/docs/consistency.test.ts` |

## What did you investigate first, and why?

I refused to redesign from intuition. The starter advertised a CLI, an MCP
server, Git inspection and validations, so the first job was to learn what it
actually did under executable pressure.

I began with the toolchain and packaging surface: `npm install`, typecheck,
build, the single existing test, `package.json#bin`, and the emitted `dist/`
layout. That alone produced defects #1 and #2 — the class packaging smoke tests
exist to catch.

Then I built a fixture repository on purpose: a feature branch one commit ahead
of `main`, plus a staged file, an unstaged edit and an untracked file, under a
directory whose name contained a space. Driving the CLI against it made the
failures concrete rather than theoretical, producing #3 through #9.

I read the MCP entry point directly, which produced #10 through #12. Finally I
probed Git argument handling, which produced #13 — and #13 is what taught me the
lesson that later produced #14: *the absence of a shell is not the absence of
execution.* Git has its own option parser, and, as it turned out, its own
configuration-driven exec paths.

I treated that inventory as the acceptance bar: every defect had to become either
a fixed behaviour with a regression, or an explicitly documented limitation.

## What did you choose to implement or fix?

I replaced the starter rather than patching around a string-returning core. The
architecture is one typed review engine and two thin adapters that are unequal in
authority on purpose.

**Shared engine.** `reviewRepository` owns the review. The result is a versioned
`ReviewResult` derived from Zod schemas, so CLI JSON, MCP `structuredContent` and
the MCP output schema cannot drift by construction. Diagnostics are a closed
taxonomy; exit codes are mapped in one place. Text budgeting strips ANSI,
resolves carriage-return overwrites, clamps on UTF-8 boundaries, and enforces a
whole-result byte budget against the actual pretty-printed JSON after truncation
metadata is attached.

**Git inspection.** Four disjoint scopes — committed, staged, unstaged,
untracked — plus a deduplicated `files` union with a `scopes` array per path.
Rename and copy orientation use the correct `-z` field order for status versus
diff. Base-ref discovery, merge-base resolution, unborn and detached HEADs,
conflicted merges, submodules, ignored paths and nested untracked trees are
handled deliberately. Caller-supplied refs are rejected if they look like
options, validated as commits, and placed after `--end-of-options`. Inspection
uses `--no-optional-locks` so the tool does not rewrite `.git/index` while
claiming to be read-only.

**Repository config is disarmed before the work tree is read** (#14). Two
fixed-name executable keys are pinned unconditionally with `-c key=`; the
remaining driver families are enumerated with
`git config --list -z --show-scope` and blanked, but only in `local` and
`worktree` scope, so a developer's global `git-lfs` filters keep working. A key
that cannot be safely written back as `-c <key>=` is fatal rather than skipped.
The ordering is load-bearing and documented in `src/git/inspect.ts`: the audit
runs after the work-tree check (so a missing path still reports `E_NOT_A_REPO`)
and before anything that reads the work tree (so no vector has fired yet).

**Validation execution.** No shell. Commands spawn from argv arrays with closed
stdin, a scrubbed environment, per-command and total deadlines, process-group
termination, continued pipe draining after the byte cap, and sequential execution
because validations contend for the same tree. The operator owns the allowlist;
repository-local config is ignored unless explicitly opted into on the CLI, and
never on MCP.

**CLI adapter.** Markdown or JSON, stdout reserved for the report, stderr for
diagnostics, stable exit codes (`0/1/2/3/4/70`), named and ad-hoc validations,
output files, timeouts and detail levels. Ad-hoc `--validate` is allowed here
because the caller already has equivalent shell authority.

**MCP adapter.** Same engine, narrower surface: `repo_path` confined under
`--root` after realpath, validation **names** only, no command-string field in
the schema, summary detail and tighter budgets by default, and layered failure
semantics (`isError` means the tool failed; `ok: false` means the review
completed with bad news). Neither tool exposes any input that could re-enable
repository config execution, and a test asserts that against the *advertised
schema* rather than the source.

## What did you intentionally not do?

I kept the product promise narrow: report what changed, and whether authorised
validations still pass.

I did not add LLM-generated "AI code review", diff-body or AST analysis, watch
mode, caching, incremental inspection, HTTP/SSE transport, authentication
sessions, a plugin or rule engine, severity scoring frameworks, or Windows
support. I avoided heavyweight CLI/Git libraries (`commander`, `yargs`,
`simple-git`) because the flag surface is small enough to parse by hand and
because a Git wrapper would have hidden the `-z`, argument-injection and config
details the starter got wrong.

I did not claim an OS sandbox. Validations are hardened and allowlisted, but they
still run with the operator's privileges. Overclaiming isolation would be worse
than the original bugs.

**On scope.** The brief says a thoughtful submission with modest changes beats a
big diff, and I did the opposite — this is a rewrite. The honest reason: the
starter's core returned formatted strings, so every fix I wanted was blocked on a
typed result contract, and #10's schema/handler split could not be fixed without
one either. I think that call was right, and the table above exists precisely so
the cost of it (an unreadable diff) is paid back. But it is a judgement you may
disagree with, and it is the main thing I would defend in conversation.

## Interface decision

**Decision.** CLI-first, with MCP as a deliberately narrower derived surface.
Not a symmetric hybrid: the two interfaces share one engine and one result
schema, but they are unequal in authority because their callers are unequal in
trust.

**Trust boundary.** A developer who types `--validate "npm test"` gains no
authority they did not already have. An MCP caller's inputs are influenced by
repository text — READMEs, comments, fixtures — so a free-form command parameter
is a confused-deputy escalation. MCP may therefore choose only a name from an
operator-owned allowlist, and may inspect only paths resolving inside the
server's `--root`.

**Why MCP still earns its place.** The usual pitch for MCP is that it grants a
new capability. Here it is the opposite: for an agent that would otherwise hold
an unrestricted shell, this server is a capability *reduction* — discoverable
schema, structured output, explicit budgets, and an allowlist the model cannot
extend.

**What #14 changed about this argument.** It sharpened it. "Read-only" turned out
to have two meanings — writes no state, and executes nothing — and MCP clients
use `readOnlyHint` to decide what to auto-approve *without asking a human*. A
capability-reduction story is only worth telling if the reduced surface is
genuinely reduced, so the annotation has to be true in the stronger sense.

**Consistency.** Both adapters call `reviewRepository` and serialise through the
same JSON path. For the same normalised request, CLI `--format json` and MCP
`structuredContent` are deep-equal after scrubbing measured durations and the
absolute repository path, with intentional default divergences pinned separately
(`test/consistency/cli-mcp-parity.test.ts`).

**What would change the decision.** Real per-call container or VM isolation could
safely widen MCP. Telemetry showing agents never need even named validations, or
that they routinely mis-specify `repo_path` and drown in output, would justify
shrinking or removing MCP rather than maintaining a misleading wrapper.

## How did you use an AI coding agent?

I used one as an accelerator for research, drafting and mechanical exploration,
not as an unsupervised author. My working rule: a suggestion is a hypothesis
until it survives contact with the repository. "Looks correct" was never enough —
I required reproduction in source, a temporary Git fixture, a subprocess, or an
automated test.

**Where I should set your expectations honestly:** I designed the architecture,
the trust model, the module boundaries, the security claims and the tests that
prove them, and I read those files line by line. The bulk expansion of the test
suite — additional table-driven cases within patterns I had established — was
agent-generated and I reviewed it in groups rather than line by line, trusting
the suite's own failures to catch mistakes. Twice that trust was misplaced in an
instructive way, and both times the failure was a test passing for the wrong
reason (below). I would rather tell you where the boundary of my verification is
than imply there isn't one.

## Where did you check, correct, or reject an AI suggestion? (required)

**Rejected: a symmetric CLI/MCP command surface.** The attractive "hybrid" story
lets both interfaces accept free-form validation commands. I rejected it after
walking the confused-deputy path: an agent's tool arguments are influenced by
repository content, so a command string over MCP turns inspection into arbitrary
execution under the operator's privileges. MCP has no command-string input at
all.

**Corrected: "argv arrays make execution safe."** Necessary for shell injection,
insufficient for Git. I reproduced an arbitrary file write through the starter's
exact `execFileSync` call shape using `--output=/tmp/...` as a base ref, with no
shell involved.

**Corrected: a security test that passed for the wrong reason (#13).** An early
test called the public inspect entry point with a hostile `--output=` ref and
asserted non-creation. It stayed green after I disabled the defences as a
negative control, because resolve-before-use rejected the ref before the write
path ran. I rewrote it against argv construction, so the suite fails if
`--end-of-options` is removed.

**Corrected: the same mistake again, while fixing #14 — and this one is the most
useful thing in this document.** My first hardening suite had three tests
asserting "the probe was not executed", all green, all worthless. The probe
script lived under the fixture work tree, and `makeRepo` deliberately puts a
space in every fixture path — but git treats a config value as a command *line*
and splits it on whitespace, so the probe could never have run under any
conditions. The defence was untested and the tests said otherwise.

What caught it was not review. It was writing the **armed** half first: a sibling
test that runs the identical fixture with hardening disabled and asserts the
marker *does* appear. That test failed, which is the only reason I learned the
other three were vacuous. Every vector in
`test/adversarial/git-config-exec.test.ts` now ships as an armed/disarmed pair,
and probes live in a space-free directory. The general lesson I took: **an
assertion that something did not happen is worthless without a sibling proving it
can happen.**

**Corrected: an audit built on `git config --list --local`.** The obvious way to
enumerate a repository's own config. It does **not** resolve `include.path`, so a
hostile key one file away is invisible while still executing. I verified this
directly, then switched to `--list -z --show-scope`, which resolves includes and
attributes each key to the scope of the file that pulled it in.

**Corrected: "just block the dangerous keys."** Blanking `filter.*.clean`
wholesale breaks `git-lfs`, which sets it legitimately — in **global** scope, on
real developer machines, including mine. Scope is what distinguishes an attack
from a normal setup, which is why the audit filters on it rather than on key name
alone.

**Corrected: my own claim about the starter's shell hole.** A comment I had
written in `src/git/exec.ts` said the starter "interpolated paths into a shell
string". Re-reading the starter to build the table above, that is wrong:
`src/git.ts` already used `execFileSync` with an argv array. The shell was in
`src/validation.ts` (`exec(command)`), and the path corruption was a separate
defect in `src/cli.ts` (`.split(" ")[0]`). Three real defects, blurred into one
inaccurate sentence, in a security comment. Corrected in place.

**Corrected: `--untracked-files=normal`.** Git's default collapses an untracked
directory to a single entry ending in `/`, under-reporting trees an agent just
created. Output size is bounded elsewhere, so I switched to `=all` and modelled
Git's remaining opaque nested-repo marker explicitly as `kind: "directory"`.

**Corrected: assume the MCP SDK mirrors `structuredContent` into text.** In SDK
1.29.0, returning only structured content yields empty `content`. I populate
both.

**Rejected as overengineering:** LLM review features, HTTP transport, plugin
engines, diff-content analysis, and wrapping Git behind `simple-git`.

## Commands used to verify the result, with outcomes

```text
npm run typecheck   PASS
npm run build       PASS; both declared bin targets produced and executable
npm test            PASS; 18 files, all green (run it for the count — this file
                    deliberately does not quote a number that would rot)
npm run verify      PASS
```

Verified locally on macOS (Node 22.23.1) **and on GitHub Actions, Linux, Node 20
and Node 22** — the workflow is `.github/workflows/public-checks.yml` and its runs
are public on the repository. What the gates exercise:

- **Unit** — `-z` parsers including opposite rename field order, the tokeniser's
  rejection of shell metacharacters, config trust rules, renderers, UTF-8-safe
  truncation, and the `--show-scope` record framing.
- **Git integration** — real temporary repositories for unborn HEAD, missing
  `main`, detached HEAD, unrelated histories, renames, ignores, exotic paths,
  argument-injection refusal, trailing-whitespace work-tree names.
- **Validation integration and adversarial** — non-zero exits reported rather
  than thrown, timeouts kill the process group, total deadlines stop the active
  command and deny the remainder, large output truncated without hanging, secrets
  not inherited.
- **Repository config execution** — each vector as an armed/disarmed pair, plus
  the `include.path` indirection, the fail-closed path, and the scope rule that
  keeps `git-lfs` working.
- **CLI subprocess** — the real `{stdout, stderr, exit code}` contract, usage
  errors exiting 2 and inspection failures exiting 3.
- **MCP contract and security** — over `InMemoryTransport`: schema shape, path
  confinement, refusal of repository-controlled config, no input that re-enables
  config execution, and the three failure layers.
- **Parity** — CLI JSON deep-compared with MCP structured content, default
  divergences pinned.
- **Documentation** — every parser flag appears in the README, the committed
  config names only npm scripts that exist, referenced test paths exist, and no
  file pins a test count.
- **Packaging** — `npm pack`, install into a clean project, run the installed
  binary.

## A blocker you hit and how you approached it

The first was environmental. The shell's default Node was 20.12.2; Vitest 4 pulls
Vite 8, which declares `node >= 20.19 || >= 22.12`, so the runner crashed during
startup before any project test imported. That looked like a product failure
until I checked resolved dependency engines and reproduced the crash on an empty
Vitest run. I treated it as a toolchain boundary: switched the verification PATH
to Node 22.23.1, declared `engines.node: ">=20.19"`, aligned the CI matrix, then
reran everything. Keeping it separate mattered — once the runner started, the
remaining failures were ordinary product defects.

The second was harder and is the one I would actually talk about: **false
confidence from green tests.** It happened twice, in the same shape, months of
experience apart in feel — a test asserting an absence, with nothing establishing
that the presence was ever achievable. The first instance (#13) I found by
disabling a defence as a negative control. The second (#14) I found only because
I happened to write the armed case, and it failed. The fix was methodological
rather than technical: absence-assertions now ship in pairs, and the security
tests aim at argv construction as well as at observable effects.

The ordering constraint in `resolveNeutralisedConfigKeys` was a smaller version
of the same discipline: my first placement ran the audit before the work-tree
check, which silently turned nine existing "path does not exist" tests from
`E_NOT_A_REPO` into `E_GIT_FAILED`. The suite caught it. Diagnosis precision and
the new defence are both requirements, so the ordering had to satisfy both rather
than trading one away.

## Known limitations and the next three things you would do

The allowlist is a mitigation, not a sandbox: once a command starts it has the
operator's filesystem, network and user privileges. A grandchild that creates a
new session can escape POSIX process-group cleanup.

The config audit is a read followed by a use, so a repository whose `.git/config`
is rewritten *between* those steps by a concurrent writer could still land a
driver; the two fixed-name keys are pinned unconditionally precisely because they
need no read, but enumerated families cannot be. Disarming can also change what
is reported — a repository that legitimately configures a local `clean` filter
will have it disabled, and git may then call a filtered file modified. Every
blanked key is named in a warning.

Embedded repositories remain opaque `kind: "directory"` markers because that is
how Git reports them. Submodules are not descended into. Diff bodies are never
emitted. Shell syntax in `--validate` is rejected, not interpreted. Validations
run sequentially. Rename detection uses Git's default thresholds. Non-UTF-8 paths
and binary output are lossy under UTF-8 decoding, though truncation never splits a
code point. Windows is unsupported.

Next three things:

1. Extend the executable-config audit to the paths I have not covered:
   `core.hooksPath` under any subcommand that would run a hook, and
   `.gitmodules`-driven submodule config if submodule descent is ever added.
2. Add an optional container-backed validation mode for operators who need
   stronger isolation than an allowlist can provide.
3. Add Windows-specific process-tree termination and path confinement tests
   before ever claiming Windows support.

## Approximate focused-work time

**Approximately 80 minutes of concentrated work.**
