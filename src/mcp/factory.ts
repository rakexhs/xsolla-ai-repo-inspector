/**
 * The MCP surface, as a *factory*.
 *
 * `createServer` builds a fully-configured `McpServer` and returns it without
 * connecting a transport. That separation is the whole point of this module:
 * the starter called `await server.connect(new StdioServerTransport())` at
 * module top level, which meant importing the server *was* starting the server,
 * and the MCP surface was therefore untestable. Every test in `test/mcp/` drives
 * this factory in-process over `InMemoryTransport`, with no subprocess.
 *
 * Three design decisions are load-bearing here.
 *
 * 1. **The input key is `repo_path` and the handler reads `input.repo_path`.**
 *    The starter advertised `repo_path` and read `input.repoPath`, which is
 *    always `undefined`. The undefined value became `cwd: undefined` on the Git
 *    subprocess, so the server silently inspected *its own* working directory
 *    and returned a confident, wrong answer. The handler was typed `any`, so the
 *    compiler could not see it. Here the handler argument is inferred from the
 *    zod raw shape, so a rename on one side is a type error on the other, and
 *    `test/mcp/contract.test.ts` additionally asserts that the requested
 *    repository is the one that appears in `repository.path`.
 *
 * 2. **Capability is split across two tools.** `inspect_repository` reads Git
 *    and cannot execute anything; `run_validations` can execute allowlisted
 *    commands. A client deciding whether to auto-approve a call needs that
 *    distinction to be visible *before* the call, which is what the
 *    `readOnlyHint` annotation is for. Marking a command-executing tool
 *    read-only would be a lie with security consequences, so `run_validations`
 *    is explicitly `readOnlyHint: false` — and it is not registered at all when
 *    the allowlist is empty, because advertising a capability you will always
 *    refuse is worse than not advertising it.
 *
 * 3. **`isError` means "the tool failed", not "the news is bad".** A review that
 *    completes with a failing test suite is a *successful* tool call carrying
 *    `structuredContent.ok === false`. `isError: true` is reserved for "I could
 *    not produce a review at all". Getting this backwards makes an agent retry
 *    a call that already answered its question.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Diagnostic, DiagnosticCode } from "../core/errors.js";
import { describeError, isFatalCode } from "../core/errors.js";
import { reviewRepository } from "../core/review.js";
import type {
  DetailLevel,
  Limits,
  ReviewRequest,
  ReviewResult,
  Scope,
} from "../core/types.js";
import {
  DETAIL_LEVELS,
  MCP_LIMITS,
  REVIEW_RESULT_SHAPE,
  SCHEMA_VERSION,
  SCOPES,
} from "../core/types.js";
import { toStructuredContent } from "../render/json.js";
import { renderTextSummary } from "../render/markdown.js";
import type { InspectorConfig } from "../validation/config.js";
import { planValidations } from "../validation/config.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export type ServerOptions = {
  /**
   * Confinement root. Every `repo_path` must resolve (through `fs.realpath`)
   * inside this directory, or the call is refused with `E_PATH_OUTSIDE_ROOT`.
   *
   * The root itself is a legal target: an operator who launches the server with
   * `--root /srv/checkout` plainly means that checkout to be inspectable.
   */
  root: string;
  /**
   * The operator's allowlist. Always supplied by whoever launched the server —
   * this module never reads a config file, and in particular never reads one
   * out of the repository being inspected, because on this surface the model
   * chooses the repository path.
   */
  config: InspectorConfig;
  /** Defaults to `MCP_LIMITS`, which are far tighter than the CLI's. */
  limits?: Limits;
};

export const SERVER_NAME = "ai-repo-inspector";
export const SERVER_VERSION = "2.0.0";

/** The two tool names, exported so tests and docs cannot drift from the code. */
export const TOOL_INSPECT = "inspect_repository";
export const TOOL_RUN_VALIDATIONS = "run_validations";

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Matches an absolute-looking POSIX path of at least two segments.
 *
 * Deliberately does not match a single leading slash followed by one segment,
 * so ordinary prose ("exit code 1/2") survives, while `/Users/someone/secrets`
 * does not.
 */
const ABSOLUTE_PATH_RE = /\/(?:[^\s/'"`:;,()[\]]+\/)+[^\s/'"`:;,()[\]]*/g;

const MAX_INTERNAL_MESSAGE_CHARS = 300;

/**
 * Reduces an unexpected throw to one safe line.
 *
 * A thrown error's `message` reaches the model verbatim, so it is an untrusted
 * *output* surface: it must never carry a stack trace (which leaks the server's
 * own source layout) nor an absolute filesystem path (which leaks the
 * operator's machine). Only the first line survives — stack frames live on the
 * lines after it — and every absolute path in that line is redacted.
 */
function sanitiseInternalMessage(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? "";
  const redacted = oneLine(firstLine).replace(ABSOLUTE_PATH_RE, "<path>");
  const message = redacted === "" ? "an unexpected internal error occurred" : redacted;
  return message.length > MAX_INTERNAL_MESSAGE_CHARS
    ? `${message.slice(0, MAX_INTERNAL_MESSAGE_CHARS - 3)}...`
    : message;
}

/** The one error line format: `<CODE>: <message>`, plus an optional hint line. */
function errorText(code: DiagnosticCode, message: string, hint?: string): string {
  const head = `${code}: ${oneLine(message)}`;
  return hint === undefined ? head : `${head}\nHint: ${oneLine(hint)}`;
}

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

/**
 * True when `target` is `root` or lies beneath it.
 *
 * `target.startsWith(root)` is the bug this replaces: for root `/a/root` it
 * happily accepts the unrelated sibling `/a/root-evil`. Comparing normalised
 * relative paths segment-wise cannot make that mistake. The first-segment test
 * (rather than `rel.startsWith("..")`) also keeps a legitimately named
 * `..config` directory from being rejected.
 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true; // The root itself is a legal target.
  if (path.isAbsolute(rel)) return false; // Different volume/UNC share.
  return rel.split(path.sep)[0] !== "..";
}

/**
 * Canonicalises `target`, tolerating a path that does not exist yet.
 *
 * Confinement must be decided *before* existence, otherwise a probe for
 * `/etc/../nonexistent` would be answered with "does not exist", which is
 * itself a disclosure. So the deepest existing ancestor is realpath'd (which
 * resolves every symlink along the way, including the macOS `/tmp` ->
 * `/private/tmp` link) and the remaining literal segments are rejoined.
 */
async function canonicalise(target: string): Promise<string> {
  const trailing: string[] = [];
  let current = path.resolve(target);

  for (;;) {
    try {
      const real = await fs.realpath(current);
      if (trailing.length === 0) return real;
      return path.join(real, ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      // Filesystem root reached and still unresolvable: fall back to the
      // lexically normalised path, which is still safe to containment-check.
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Failure results
// ---------------------------------------------------------------------------

type Failure = {
  code: DiagnosticCode;
  message: string;
  hint?: string;
};

/**
 * A well-formed `ReviewResult` describing a review that could not happen.
 *
 * Returning the *same* schema on the failure path is not decoration. The SDK
 * declares `outputSchema`, and the SDK client validates any `structuredContent`
 * it receives against that schema — including on an `isError: true` result. A
 * bespoke `{ code, message }` object would therefore be rejected by a conformant
 * client. Reusing the result shape also means an agent branches on
 * `structuredContent.diagnostics[0].code` in exactly one way, whatever went
 * wrong.
 */
function failedReview(
  repositoryPath: string,
  scopes: Scope[],
  detail: DetailLevel,
  failure: Failure,
): ReviewResult {
  const diagnostic: Diagnostic = {
    code: failure.code,
    severity: "fatal",
    message: oneLine(failure.message),
  };
  if (failure.hint !== undefined) diagnostic.hint = oneLine(failure.hint);

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    detail,
    scopes,
    repository: {
      path: repositoryPath,
      head: { unborn: true, detached: false, sha: null, branch: null },
      base: null,
    },
    changes: {
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
    },
    validations: [],
    diagnostics: [diagnostic],
    truncation: { applied: false, droppedBytes: 0, fields: [] },
  };
}

function toolFailure(
  repositoryPath: string,
  scopes: Scope[],
  detail: DetailLevel,
  failure: Failure,
): CallToolResult {
  const result = failedReview(repositoryPath, scopes, detail, failure);
  return {
    isError: true,
    content: [
      { type: "text", text: errorText(failure.code, failure.message, failure.hint) },
    ],
    structuredContent: toStructuredContent(result),
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The shared inputs.
 *
 * Every key is snake_case, because that is what the tool advertises and
 * therefore what the SDK hands the handler. The identifier `repoPath` appears
 * nowhere in this file except in the comment explaining why — `grep -c repoPath`
 * is a cheap guard, and a contract test asserts the same about the schema the
 * client actually sees.
 */
function baseInputShape(root: string) {
  return {
    repo_path: z
      .string()
      .min(1)
      .describe(
        "Path to the Git repository to inspect. Must resolve inside the server's " +
          `confinement root (${root}); a relative path is resolved against that root. ` +
          "Symlinks are resolved before the check, so a link out of the root is refused.",
      ),
    base_ref: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Git ref the committed changes are diffed against, e.g. 'main' or a SHA. " +
          "Omit to auto-detect the default branch.",
      ),
    scopes: z
      .array(z.enum(SCOPES))
      .optional()
      .describe(
        `Which change scopes to inspect (default: all of ${SCOPES.join(", ")}). ` +
          "'committed' is history on this branch; the other three are working-tree state.",
      ),
    detail: z
      .enum(DETAIL_LEVELS)
      .optional()
      .describe(
        "'summary' (default) elides passing validation output and long file lists; " +
          "'full' includes everything within the configured byte budget.",
      ),
  };
}

const INSPECT_DESCRIPTION =
  "Inspect a Git repository and report what changed, split into committed, staged, " +
  "unstaged and untracked scopes. Read-only: this tool runs Git plumbing and cannot " +
  "execute project commands. Use it to find out what an edit session actually touched.";

const RUN_VALIDATIONS_DESCRIPTION =
  "Inspect a Git repository and additionally run validation commands from the " +
  "operator's allowlist (for example tests or a linter), reporting each command's " +
  "status, exit code and captured output. Only allowlisted names may be run; the " +
  "legal values are enumerated in the 'validations' argument. A failing validation " +
  "is a successful call whose result has ok=false, not a tool error.";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions): McpServer {
  const { config } = options;
  const limits = options.limits ?? MCP_LIMITS;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Inspects Git repositories under ${options.root}. Call ${TOOL_INSPECT} to see ` +
        `what changed without executing anything. ${TOOL_RUN_VALIDATIONS} additionally ` +
        "runs allowlisted commands and is only present when the operator allowlisted at " +
        "least one. On both tools, isError=true means the repository could not be " +
        "inspected; a completed review whose validations failed returns isError=false " +
        "with ok=false in the structured result.",
    },
  );

  // The root is realpath'd once, lazily: `createServer` is synchronous, and the
  // resolved value must be the *canonical* root or the containment check would
  // compare a symlinked root against realpath'd targets and reject everything
  // (on macOS, /tmp vs /private/tmp).
  let cachedRoot: Promise<string> | null = null;
  const resolveRoot = (): Promise<string> => {
    if (cachedRoot === null) {
      cachedRoot = fs
        .realpath(path.resolve(options.root))
        .catch(() => path.resolve(options.root));
    }
    return cachedRoot;
  };

  type ReviewArgs = {
    requestedPath: string;
    baseRef: string | undefined;
    scopes: Scope[] | undefined;
    detail: DetailLevel | undefined;
    validationNames: string[];
  };

  async function review(args: ReviewArgs): Promise<CallToolResult> {
    const detail: DetailLevel = args.detail ?? "summary";
    const scopes: Scope[] = args.scopes ?? [...SCOPES];
    const echo = args.requestedPath; // Only ever the caller's own string, never a realpath.

    const root = await resolveRoot();
    const target = path.isAbsolute(args.requestedPath)
      ? args.requestedPath
      : path.resolve(root, args.requestedPath);
    const canonical = await canonicalise(target);

    if (!isInsideRoot(root, canonical)) {
      return toolFailure(echo, scopes, detail, {
        code: "E_PATH_OUTSIDE_ROOT",
        message:
          `repo_path ${JSON.stringify(args.requestedPath)} resolves outside this server's ` +
          "confinement root and was refused; nothing was inspected",
        hint:
          "Pass a path inside the root this server was launched with. Symlinks are " +
          "resolved before the check, so a link pointing out of the root is also refused.",
      });
    }

    // The trust decision, made once, from the operator's config only. `restrictTo`
    // is defence in depth: `run_validations` already constrains the argument to a
    // zod enum built from this same list, so a non-allowlisted name cannot reach
    // here — but the two layers are independent on purpose.
    const plan = planValidations({
      config,
      names: args.validationNames,
      adHoc: [],
      adHocAllowed: false,
      restrictTo: config.mcp.allowValidations,
      defaultTimeoutMs: limits.validationTimeoutMs,
    });

    const planError = plan.errors[0];
    if (planError !== undefined) {
      return toolFailure(echo, scopes, detail, {
        code: planError.code,
        message: planError.message,
        ...(planError.hint !== undefined ? { hint: planError.hint } : {}),
      });
    }

    const request: ReviewRequest = {
      repositoryPath: canonical,
      ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
      scopes,
      detail,
      validations: plan.planned,
      denied: plan.denied,
      limits,
    };

    const result = await reviewRepository(request);

    // Re-check after inspection. `git rev-parse --show-toplevel` walks *up*, so
    // a directory inside the root can belong to a repository whose root is an
    // ancestor of the confinement root — in which case the review describes a
    // repository the caller was never allowed to see.
    if (!isInsideRoot(root, result.repository.path)) {
      return toolFailure(echo, scopes, detail, {
        code: "E_PATH_OUTSIDE_ROOT",
        message:
          `repo_path ${JSON.stringify(args.requestedPath)} belongs to a Git repository whose ` +
          "root lies outside this server's confinement root; the review was discarded",
        hint: "Inspect a repository whose top level is inside the configured root.",
      });
    }

    const fatal = result.diagnostics.find(
      (diagnostic) => diagnostic.severity === "fatal" && isFatalCode(diagnostic.code),
    );

    if (fatal !== undefined) {
      // Layer 2: the tool could not do its job. Still ships `structuredContent`
      // so the caller can branch on the code rather than parse English.
      return {
        isError: true,
        content: [{ type: "text", text: errorText(fatal.code, fatal.message, fatal.hint) }],
        structuredContent: toStructuredContent(result),
      };
    }

    // Layer 3: the review completed. `ok` may still be false (a validation
    // failed); that is bad news, not a failed call.
    return {
      isError: false,
      content: [{ type: "text", text: renderTextSummary(result) }],
      structuredContent: toStructuredContent(result),
    };
  }

  /** Converts an unexpected throw into a sanitised `E_INTERNAL` tool error. */
  async function guarded(args: ReviewArgs): Promise<CallToolResult> {
    try {
      return await review(args);
    } catch (error) {
      return toolFailure(args.requestedPath, args.scopes ?? [...SCOPES], args.detail ?? "summary", {
        code: "E_INTERNAL",
        message: sanitiseInternalMessage(describeError(error)),
        hint: "This is a bug in the inspector. Retrying with the same arguments will not help.",
      });
    }
  }

  server.registerTool(
    TOOL_INSPECT,
    {
      title: "Inspect repository changes",
      description: INSPECT_DESCRIPTION,
      inputSchema: baseInputShape(options.root),
      outputSchema: REVIEW_RESULT_SHAPE,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      guarded({
        // `input.repo_path` — snake_case on both sides. See the module header.
        requestedPath: input.repo_path,
        baseRef: input.base_ref,
        scopes: input.scopes,
        detail: input.detail,
        validationNames: [],
      }),
  );

  // Only advertise execution when execution is actually possible. An empty
  // allowlist means every call would be refused, and a tool that always refuses
  // is worse than an absent one: it burns a turn and teaches the agent nothing.
  const allowed = [...new Set(config.mcp.allowValidations)].sort();
  const [firstAllowed, ...restAllowed] = allowed;

  if (firstAllowed !== undefined) {
    // `z.enum` needs a non-empty tuple, which the destructuring above proves.
    // Putting the legal names in the advertised schema is a real discoverability
    // win: the agent sees what it may run without a failed call first.
    const validationEnum = z.enum([firstAllowed, ...restAllowed] as [string, ...string[]]);

    const describeAllowed = allowed
      .map((name) => {
        const description = config.validations[name]?.description;
        return description === undefined ? name : `${name} (${oneLine(description)})`;
      })
      .join("; ");

    server.registerTool(
      TOOL_RUN_VALIDATIONS,
      {
        title: "Run allowlisted validations",
        description: RUN_VALIDATIONS_DESCRIPTION,
        inputSchema: {
          ...baseInputShape(options.root),
          validations: z
            .array(validationEnum)
            .min(1)
            .describe(`Allowlisted validation names to run. Available: ${describeAllowed}.`),
        },
        annotations: {
          // Never `readOnlyHint: true` on a tool that executes commands: clients
          // use that hint to decide what to auto-approve.
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        outputSchema: REVIEW_RESULT_SHAPE,
      },
      async (input) =>
        guarded({
          requestedPath: input.repo_path,
          baseRef: input.base_ref,
          scopes: input.scopes,
          detail: input.detail,
          validationNames: input.validations,
        }),
    );
  }

  return server;
}
