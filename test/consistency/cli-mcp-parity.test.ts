/**
 * Cross-interface consistency — the centrepiece test.
 *
 * The product claims that the CLI and the MCP server are the same engine behind
 * two thin adapters. A claim like that is worthless unless it is executable, so
 * this suite asserts it two ways:
 *
 *   1. PARITY — given the *same normalised request*, the CLI's `--format json`
 *      stdout and the MCP tool's `structuredContent` are deep-equal after
 *      scrubbing declared nondeterminism (measured durations and the absolute
 *      repository path).
 *
 *   2. DIVERGENCE — at their *default* settings the two adapters deliberately
 *      differ, and the difference is pinned here. Naive deep-equality at
 *      defaults is neither achievable nor desirable: MCP defaults to `summary`
 *      detail with far tighter budgets and forbids ad-hoc commands, and those
 *      are safety properties, not accidents. Pinning the divergence means
 *      accidental drift fails CI while intentional drift stays legible.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CLI_LIMITS, MCP_LIMITS, ReviewResultSchema } from "../../src/core/types.js";
import { createServer, TOOL_RUN_VALIDATIONS } from "../../src/mcp/factory.js";
import { loadConfig } from "../../src/validation/config.js";
import { makeRepo, type RepoHandle } from "../helpers/repo.js";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * A validation that is byte-for-byte deterministic, so the only thing left to
 * scrub is its measured duration. `node` is used bare (not `process.execPath`)
 * because config `argv[0]` may not contain a path separator.
 */
const DETERMINISTIC_ARGV = [
  "node",
  "-e",
  "process.stdout.write('parity-check-output')",
];

let repo: RepoHandle;
let configPath: string;
let configDir: string;

/**
 * Removes everything that legitimately differs between two runs of the same
 * review: wall-clock measurements, and the absolute path of a temp directory.
 */
function scrub(value: unknown, repoPath: string): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, repoPath));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // Measured durations are the only intentionally nondeterministic field.
      if (key === "durationMs") continue;
      out[key] = scrub(inner, repoPath);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.split(repoPath).join("<REPO>");
  }
  return value;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(PROJECT_ROOT, "src/cli/main.ts"), ...args],
      {
        // `--import tsx` resolves the loader relative to the child's cwd, so
        // this must stay pinned to the project root.
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ structured: unknown; isError: boolean; text: string }> {
  const { config } = await loadConfig({
    explicitPath: configPath,
    allowRepoConfig: false,
  });

  const server = createServer({ root: repo.root, config });
  const client = new Client({ name: "parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = (await client.callTool({
      name: toolName,
      arguments: args,
    })) as {
      structuredContent?: unknown;
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    return {
      structured: result.structuredContent,
      isError: result.isError === true,
      text: result.content?.[0]?.text ?? "",
    };
  } finally {
    await client.close();
    await server.close();
  }
}

beforeAll(async () => {
  // A path containing a space, exercising the starter's headline bug on both
  // interfaces at once.
  repo = await makeRepo("parity repo");

  await repo.write("kept.txt", "original\n");
  await repo.write("removed.txt", "gone soon\n");
  await repo.commit("base commit");

  await repo.run("checkout", "-q", "-b", "feature");
  await repo.write("added-committed.txt", "new on branch\n");
  await repo.write("kept.txt", "original\nmodified on branch\n");
  await repo.remove("removed.txt");
  await repo.commit("feature commit");

  await repo.write("staged.txt", "staged content\n");
  await repo.run("add", "staged.txt");
  await repo.write("kept.txt", "original\nmodified on branch\nunstaged\n");
  await repo.write("untracked.txt", "untracked content\n");

  configDir = await mkdtemp(path.join(tmpdir(), "inspector-parity-config-"));
  configPath = path.join(configDir, "inspector.config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        validations: {
          echo: { argv: DETERMINISTIC_ARGV, timeoutMs: 30_000 },
        },
        mcp: { allowValidations: ["echo"] },
      },
      null,
      2,
    ),
  );
}, 120_000);

afterAll(async () => {
  await repo?.cleanup();
  if (configDir) await rm(configDir, { recursive: true, force: true });
});

describe("CLI and MCP produce identical results for the same request", () => {
  it("matches for a repository with changes in all four scopes", async () => {
    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--detail",
      "summary",
      "--base-ref",
      "main",
      "--config",
      configPath,
      "--validation",
      "echo",
    ]);
    expect(cli.code, `CLI failed:\n${cli.stderr}`).toBe(0);

    const cliResult = JSON.parse(cli.stdout) as unknown;

    const mcp = await callMcpTool(TOOL_RUN_VALIDATIONS, {
      repo_path: repo.dir,
      base_ref: "main",
      detail: "summary",
      validations: ["echo"],
    });
    expect(mcp.isError).toBe(false);

    // Both must be valid instances of the shared contract before comparison,
    // otherwise "equal" could mean "equally malformed".
    expect(() => ReviewResultSchema.parse(cliResult)).not.toThrow();
    expect(() => ReviewResultSchema.parse(mcp.structured)).not.toThrow();

    expect(scrub(cliResult, repo.dir)).toEqual(scrub(mcp.structured, repo.dir));
  }, 120_000);

  it("matches at full detail as well as summary", async () => {
    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--detail",
      "full",
      "--base-ref",
      "main",
    ]);
    expect(cli.code, `CLI failed:\n${cli.stderr}`).toBe(0);

    const mcp = await callMcpTool("inspect_repository", {
      repo_path: repo.dir,
      base_ref: "main",
      detail: "full",
    });
    expect(mcp.isError).toBe(false);

    expect(scrub(JSON.parse(cli.stdout), repo.dir)).toEqual(
      scrub(mcp.structured, repo.dir),
    );
  }, 120_000);

  it("matches when the repository cannot be inspected", async () => {
    // Failure paths drift more easily than success paths, because each adapter
    // is tempted to format its own error.
    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--base-ref",
      "definitely-not-a-ref",
      "--exit-zero",
    ]);
    const cliResult = JSON.parse(cli.stdout) as { ok: boolean; diagnostics: unknown[] };
    expect(cliResult.ok).toBe(false);

    const mcp = await callMcpTool("inspect_repository", {
      repo_path: repo.dir,
      base_ref: "definitely-not-a-ref",
    });
    expect(mcp.isError).toBe(true);

    const cliScrubbed = scrub(cliResult, repo.dir) as Record<string, unknown>;
    const mcpScrubbed = scrub(mcp.structured, repo.dir) as Record<string, unknown>;

    // The detail level is the one field that differs here, because the CLI
    // defaulted to `full` and MCP to `summary`; everything about the failure
    // itself must be identical.
    expect(mcpScrubbed["diagnostics"]).toEqual(cliScrubbed["diagnostics"]);
    expect(mcpScrubbed["ok"]).toEqual(cliScrubbed["ok"]);
    expect(mcpScrubbed["changes"]).toEqual(cliScrubbed["changes"]);
  }, 120_000);

  it("reports a failing validation identically, and as a successful tool call", async () => {
    const failingConfig = path.join(configDir, "failing.json");
    await writeFile(
      failingConfig,
      JSON.stringify({
        validations: { boom: { argv: ["node", "-e", "process.exit(3)"] } },
        mcp: { allowValidations: ["boom"] },
      }),
    );

    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--detail",
      "summary",
      "--base-ref",
      "main",
      "--config",
      failingConfig,
      "--validation",
      "boom",
    ]);
    // Exit 1 = "the tool worked, your code failed".
    expect(cli.code).toBe(1);
    const cliResult = JSON.parse(cli.stdout) as { ok: boolean };
    expect(cliResult.ok).toBe(false);

    const { config } = await loadConfig({
      explicitPath: failingConfig,
      allowRepoConfig: false,
    });
    const server = createServer({ root: repo.root, config });
    const client = new Client({ name: "parity-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    try {
      const mcp = (await client.callTool({
        name: TOOL_RUN_VALIDATIONS,
        arguments: {
          repo_path: repo.dir,
          base_ref: "main",
          detail: "summary",
          validations: ["boom"],
        },
      })) as { structuredContent?: unknown; isError?: boolean };

      // The load-bearing distinction: a failing test suite is a *successful*
      // tool call. isError means the tool failed, not that the news is bad.
      expect(mcp.isError ?? false).toBe(false);
      expect((mcp.structuredContent as { ok: boolean }).ok).toBe(false);

      expect(scrub(cliResult, repo.dir)).toEqual(
        scrub(mcp.structuredContent, repo.dir),
      );
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});

describe("the adapters' default divergence is deliberate and pinned", () => {
  it("declares exactly the intended differences in default limits", () => {
    // If someone "harmonises" these, the MCP surface silently starts emitting
    // CLI-sized payloads into a model's context window. Pin them.
    expect(MCP_LIMITS.maxOutputBytesPerStream).toBeLessThan(
      CLI_LIMITS.maxOutputBytesPerStream,
    );
    expect(MCP_LIMITS.maxTotalBytes).toBeLessThan(CLI_LIMITS.maxTotalBytes);
    expect(MCP_LIMITS.maxFilesPerScope).toBeLessThan(CLI_LIMITS.maxFilesPerScope);
    expect(MCP_LIMITS.validationTimeoutMs).toBeLessThan(
      CLI_LIMITS.validationTimeoutMs,
    );

    // Snapshot of the exact divergence set. A change here must be intentional.
    expect({
      maxOutputBytesPerStream: [
        CLI_LIMITS.maxOutputBytesPerStream,
        MCP_LIMITS.maxOutputBytesPerStream,
      ],
      maxTotalBytes: [CLI_LIMITS.maxTotalBytes, MCP_LIMITS.maxTotalBytes],
      maxFilesPerScope: [CLI_LIMITS.maxFilesPerScope, MCP_LIMITS.maxFilesPerScope],
    }).toEqual({
      maxOutputBytesPerStream: [32 * 1024, 4 * 1024],
      maxTotalBytes: [256 * 1024, 16 * 1024],
      maxFilesPerScope: [1000, 50],
    });
  });

  it("differs only in detail level when run at defaults on the same repository", async () => {
    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--base-ref",
      "main",
    ]);
    expect(cli.code).toBe(0);
    const cliResult = scrub(JSON.parse(cli.stdout), repo.dir) as Record<string, unknown>;

    const mcp = await callMcpTool("inspect_repository", {
      repo_path: repo.dir,
      base_ref: "main",
    });
    const mcpResult = scrub(mcp.structured, repo.dir) as Record<string, unknown>;

    const differing = Object.keys(cliResult).filter(
      (key) => JSON.stringify(cliResult[key]) !== JSON.stringify(mcpResult[key]),
    );

    // On a small fixture the tighter MCP budgets do not bind, so `detail` is
    // the only observable difference. That is the intended contract: the
    // adapters differ in *policy defaults*, never in engine behaviour.
    expect(differing).toEqual(["detail"]);
    expect(cliResult["detail"]).toBe("full");
    expect(mcpResult["detail"]).toBe("summary");
  }, 120_000);

  it("forbids ad-hoc commands on MCP but allows them on the CLI", async () => {
    // The CLI accepts an ad-hoc command: a developer typing one gains no
    // authority they did not already have.
    const cli = await runCli([
      "review",
      "--repo",
      repo.dir,
      "--format",
      "json",
      "--base-ref",
      "main",
      // No shell metacharacters: `node -e "process.exit(0)"` would be rejected
      // for containing parentheses, which is the tokenizer working correctly.
      "--validate",
      "node --version",
    ]);
    expect(cli.code, `CLI failed:\n${cli.stderr}`).toBe(0);
    const cliResult = JSON.parse(cli.stdout) as {
      validations: Array<{ id: string; status: string }>;
    };
    expect(cliResult.validations.length).toBe(1);
    expect(cliResult.validations[0]?.status).toBe("passed");

    // The MCP tool schema has no field through which a command string could be
    // supplied at all — the capability is absent, not merely refused.
    const { config } = await loadConfig({
      explicitPath: configPath,
      allowRepoConfig: false,
    });
    const server = createServer({ root: repo.root, config });
    const client = new Client({ name: "parity-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const serialised = JSON.stringify(tool.inputSchema);
        expect(serialised).not.toContain("validationCommands");
        expect(serialised).not.toContain("command");
      }
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});
