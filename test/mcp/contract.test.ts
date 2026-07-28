/**
 * The MCP wire contract.
 *
 * These tests speak real JSON-RPC to a real `McpServer` over
 * `InMemoryTransport`, using the SDK's own `Client`. Nothing is stubbed: the
 * client performs the same `outputSchema` validation a production host performs,
 * so a malformed `structuredContent` fails here exactly as it would in a real
 * MCP host. No subprocess is spawned for the server itself, which keeps the
 * suite fast enough to run on every save.
 *
 * The highest-value assertions in this file are two:
 *
 *  - `repository.path` equals the *requested* repository. The starter advertised
 *    `repo_path` and read `input.repoPath`; the resulting `undefined` became
 *    `cwd: undefined` on the Git subprocess, so the server inspected its own
 *    working directory and returned a confident wrong answer with no error at
 *    all. Because vitest runs with the project repo as cwd, that regression
 *    would still produce a *valid-looking* result — so the assertion is written
 *    to compare against both the requested path and the process cwd.
 *
 *  - A failing validation is `isError: false` with `ok: false`. `isError` means
 *    "the tool failed", not "the news is bad". An agent that conflates them
 *    retries a call that already answered its question.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewResultSchema } from "../../src/core/types.js";
import type { ReviewResult } from "../../src/core/types.js";
import {
  createServer,
  TOOL_INSPECT,
  TOOL_RUN_VALIDATIONS,
} from "../../src/mcp/factory.js";
import type { InspectorConfig } from "../../src/validation/config.js";
import { makeRepo } from "../helpers/repo.js";
import type { RepoHandle } from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Session = {
  client: Client;
  close(): Promise<void>;
};

async function connect(root: string, config: InspectorConfig): Promise<Session> {
  const server = createServer({ root, config });
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The SDK types `content` loosely; these narrowings keep the assertions honest. */
type ToolOutcome = {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
};

function narrow(raw: unknown): ToolOutcome {
  const result = raw as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  const first = result.content?.[0];
  expect(first, "every result must carry a content block").toBeDefined();
  expect(first?.type).toBe("text");
  return {
    isError: result.isError === true,
    text: first?.text ?? "",
    structured: result.structuredContent ?? {},
  };
}

/** Parses through the real schema, so a drifted projection is a test failure. */
function asReview(outcome: ToolOutcome): ReviewResult {
  return ReviewResultSchema.parse(outcome.structured);
}

function toolNamed(tools: readonly Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`tool ${name} was not advertised`);
  return found;
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

function inputSchemaOf(tool: Tool): JsonSchema {
  return tool.inputSchema as unknown as JsonSchema;
}

const PASSING: readonly string[] = ["node", "-e", "process.exit(0)"];
const FAILING: readonly string[] = [
  "node",
  "-e",
  "console.log('assertion failed: 1 !== 2'); process.exit(1)",
];

function configWith(allow: string[]): InspectorConfig {
  return {
    validations: {
      unit: { argv: [...PASSING], description: "the unit test suite" },
      broken: { argv: [...FAILING], description: "a suite that fails" },
      secret: { argv: [...PASSING], description: "defined but not exposed over MCP" },
    },
    mcp: { allowValidations: allow },
  };
}

// ---------------------------------------------------------------------------

describe("MCP contract", () => {
  let repo: RepoHandle;
  let session: Session;

  beforeEach(async () => {
    repo = await makeRepo("project");
    await repo.write("src/a.ts", "export const a = 1;\n");
    await repo.commit("initial");
    await repo.write("src/b.ts", "export const b = 2;\n"); // untracked
    await repo.write("src/a.ts", "export const a = 99;\n"); // unstaged
    session = await connect(repo.root, configWith(["unit", "broken"]));
  });

  afterEach(async () => {
    await session.close();
    await repo.cleanup();
  });

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  describe("tools/list", () => {
    it("advertises exactly the two tools, each with a description", async () => {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        TOOL_INSPECT,
        TOOL_RUN_VALIDATIONS,
      ]);
      for (const tool of tools) {
        expect(tool.description ?? "").not.toBe("");
        expect(tool.title ?? "").not.toBe("");
        expect(tool.outputSchema, "both tools declare an outputSchema").toBeDefined();
      }
    });

    it("requires repo_path and never mentions repoPath — the starter's exact bug", async () => {
      const { tools } = await session.client.listTools();

      for (const tool of tools) {
        const schema = inputSchemaOf(tool);
        expect(Object.keys(schema.properties ?? {})).toContain("repo_path");
        expect(schema.required).toContain("repo_path");

        // The camelCase spelling must not appear anywhere in the advertised
        // tool: not as a property, not in a description, not in an enum.
        expect(JSON.stringify(tool)).not.toContain("repoPath");
      }
    });

    it("advertises the optional inputs as optional", async () => {
      const schema = inputSchemaOf(toolNamed((await session.client.listTools()).tools, TOOL_INSPECT));
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        "base_ref",
        "detail",
        "repo_path",
        "scopes",
      ]);
      expect(schema.required).toEqual(["repo_path"]);
    });

    it("marks inspect_repository read-only and run_validations not read-only", async () => {
      const { tools } = await session.client.listTools();

      expect(toolNamed(tools, TOOL_INSPECT).annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const runAnnotations = toolNamed(tools, TOOL_RUN_VALIDATIONS).annotations;
      expect(runAnnotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      // Spelled out separately because this is the security-relevant one: a
      // client uses readOnlyHint to decide what it may auto-approve, and a tool
      // that executes commands must never claim to be read-only.
      expect(runAnnotations?.readOnlyHint).toBe(false);
    });

    it("enumerates the allowlisted validation names in the advertised schema", async () => {
      const schema = inputSchemaOf(
        toolNamed((await session.client.listTools()).tools, TOOL_RUN_VALIDATIONS),
      );
      const validations = JSON.stringify(schema.properties?.["validations"] ?? {});
      expect(validations).toContain("unit");
      expect(validations).toContain("broken");
      // Defined in the config but not allowlisted, so it must not be offered.
      expect(validations).not.toContain("secret");
      expect(schema.required).toEqual(["repo_path", "validations"]);
    });

    it("omits run_validations entirely when the allowlist is empty", async () => {
      const bare = await connect(repo.root, configWith([]));
      try {
        const { tools } = await bare.client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([TOOL_INSPECT]);
      } finally {
        await bare.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  describe("inspect_repository", () => {
    it("inspects the requested repository, not the server's own cwd", async () => {
      await session.client.listTools(); // Arms the client-side outputSchema validator.
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir },
        }),
      );

      expect(outcome.isError).toBe(false);
      const review = asReview(outcome);

      const expected = await realpath(repo.dir);
      expect(review.repository.path).toBe(expected);

      // The regression guard. vitest runs with the inspector's own repository as
      // cwd, which is itself a valid Git work tree, so the starter's bug produced
      // a well-formed result describing the wrong repository. Comparing against
      // cwd is what makes that visible.
      const cwd = await realpath(process.cwd());
      expect(review.repository.path).not.toBe(cwd);
      expect(review.changes.files.map((file) => file.path).sort()).toEqual([
        "src/a.ts",
        "src/b.ts",
      ]);
    });

    it("returns structuredContent that validates against ReviewResultSchema", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir },
        }),
      );
      // `.parse` throws on any drift; the explicit expect documents the intent.
      expect(() => ReviewResultSchema.parse(outcome.structured)).not.toThrow();
      expect(asReview(outcome).schemaVersion).toBe(1);
    });

    it("populates content[0].text as well as structuredContent", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir },
        }),
      );
      // The SDK does not mirror structuredContent into content; a client that
      // renders only `content` would otherwise show the user nothing at all.
      expect(outcome.text.length).toBeGreaterThan(0);
      expect(outcome.text).toContain("Review");
    });

    it("accepts a repo_path relative to the confinement root", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: path.basename(repo.dir) },
        }),
      );
      expect(outcome.isError).toBe(false);
      expect(asReview(outcome).repository.path).toBe(await realpath(repo.dir));
    });

    it("honours the scopes argument", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir, scopes: ["untracked"] },
        }),
      );
      const review = asReview(outcome);
      expect(review.scopes).toEqual(["untracked"]);
      expect(review.changes.untracked.map((file) => file.path)).toEqual(["src/b.ts"]);
      // The scope that was not requested must be empty rather than silently
      // included, otherwise the argument is decorative.
      expect(review.changes.unstaged).toEqual([]);
      expect(review.changes.counts.committed).toBe(0);
    });

    it("honours the detail argument", async () => {
      const summary = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir, detail: "summary" },
        }),
      );
      const full = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir, detail: "full" },
        }),
      );
      expect(asReview(summary).detail).toBe("summary");
      expect(asReview(full).detail).toBe("full");
    });

    it("honours the base_ref argument", async () => {
      const first = (await repo.run("rev-parse", "HEAD")).trim();
      await repo.write("src/c.ts", "export const c = 3;\n");
      await repo.commit("second");

      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir, base_ref: first, scopes: ["committed"] },
        }),
      );
      const review = asReview(outcome);
      expect(review.repository.base?.requested).toBe(first);
      expect(review.changes.committed.map((file) => file.path)).toContain("src/c.ts");
    });
  });

  // -------------------------------------------------------------------------
  // The three result layers
  // -------------------------------------------------------------------------

  describe("result semantics", () => {
    it("layer 1: malformed arguments are rejected by the input schema", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: 42 },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text.toLowerCase()).toContain("validation");
    });

    it("layer 1: a missing repo_path is rejected rather than defaulted", async () => {
      // The starter's failure mode was to treat an absent path as "here". An
      // absent required argument must be a rejection, never a default.
      const outcome = narrow(
        await session.client.callTool({ name: TOOL_INSPECT, arguments: {} }),
      );
      expect(outcome.isError).toBe(true);
    });

    it("layer 2: a nonexistent repository is a tool error with a machine-readable code", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: path.join(repo.root, "no-such-directory") },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/^E_NOT_A_REPO: /);
      expect(outcome.text.length).toBeGreaterThan(0);

      // Still structured, so the agent branches on the code rather than on prose.
      const review = asReview(outcome);
      expect(review.ok).toBe(false);
      expect(review.diagnostics[0]?.code).toBe("E_NOT_A_REPO");
    });

    it("layer 2: a directory that is not a repository is a tool error", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.root },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/^E_NOT_A_REPO: /);
    });

    it("layer 2: an unresolvable base_ref is a tool error", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir, base_ref: "definitely-not-a-ref" },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/^E_BASE_REF_UNKNOWN: /);
      expect(asReview(outcome).diagnostics[0]?.code).toBe("E_BASE_REF_UNKNOWN");
    });

    it("layer 3: a FAILING VALIDATION is a successful call with ok=false", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["broken"] },
        }),
      );

      // The single most important assertion in this suite. The tool did its job
      // perfectly: it ran the command and reported that the command failed.
      expect(outcome.isError).toBe(false);

      const review = asReview(outcome);
      expect(review.ok).toBe(false);
      expect(review.validations).toHaveLength(1);
      expect(review.validations[0]?.id).toBe("broken");
      expect(review.validations[0]?.status).toBe("failed");
      expect(review.validations[0]?.exitCode).toBe(1);
      expect(review.validations[0]?.stdout).toContain("assertion failed");
      expect(outcome.text).toContain("FAILED");
    });

    it("layer 3: a passing validation is a successful call with ok=true", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["unit"] },
        }),
      );
      expect(outcome.isError).toBe(false);
      const review = asReview(outcome);
      expect(review.ok).toBe(true);
      expect(review.validations[0]?.status).toBe("passed");
    });

    it("run_validations still inspects the requested repository", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["unit"] },
        }),
      );
      expect(asReview(outcome).repository.path).toBe(await realpath(repo.dir));
    });
  });

  // -------------------------------------------------------------------------
  // Discoverability of refusals
  // -------------------------------------------------------------------------

  describe("unknown validation names", () => {
    it("rejects a name that is not allowlisted and names the ones that are", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["rm-minus-rf"] },
        }),
      );
      expect(outcome.isError).toBe(true);
      // The available names must be recoverable from the refusal itself, so the
      // agent can correct in one turn instead of guessing.
      expect(outcome.text).toContain("unit");
      expect(outcome.text).toContain("broken");
    });

    it("rejects a validation defined in the config but withheld from MCP", async () => {
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["secret"] },
        }),
      );
      expect(outcome.isError).toBe(true);
    });
  });
});
