/**
 * The MCP trust boundary.
 *
 * Two properties are under test, and both are the kind that fail *silently* when
 * they regress — which is why they get a suite of their own rather than a
 * paragraph in the README.
 *
 *  1. **Confinement.** A model chooses `repo_path`. If the server will inspect
 *     anything the process can read, then a prompt-injected agent can use it as
 *     a file-disclosure oracle. Every path is canonicalised with `fs.realpath`
 *     *before* the containment test, so a symlink planted inside the root cannot
 *     smuggle a target out of it, and containment is decided on normalised
 *     relative paths rather than `startsWith`, which would accept `/a/root-evil`
 *     for root `/a/root`.
 *
 *  2. **The confused deputy.** The inspected repository must never get a vote in
 *     what may be executed. A committed `inspector.config.json` is exactly the
 *     attack: clone a repo, ask an agent to "run the tests", and the repository
 *     names the command. The assertion here is a *side effect that does not
 *     happen* — the hostile command would create a file, and the file must not
 *     exist afterwards. Asserting only on the error message would pass even if
 *     the command had run and then been reported as denied.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewResultSchema } from "../../src/core/types.js";
import type { ReviewResult } from "../../src/core/types.js";
import {
  createServer,
  TOOL_INSPECT,
  TOOL_RUN_VALIDATIONS,
} from "../../src/mcp/factory.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/validation/config.js";
import type { InspectorConfig } from "../../src/validation/config.js";
import { makeRepo } from "../helpers/repo.js";
import type { RepoHandle } from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Session = { client: Client; close(): Promise<void> };

async function connect(root: string, config: InspectorConfig): Promise<Session> {
  const server = createServer({ root, config });
  const client = new Client({ name: "security-test", version: "0.0.0" });
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
  return {
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? "",
    structured: result.structuredContent ?? {},
  };
}

function asReview(outcome: ToolOutcome): ReviewResult {
  return ReviewResultSchema.parse(outcome.structured);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts a refusal is a *complete* refusal: the code is right and the result
 * carries no evidence that anything was inspected.
 */
function expectRefusedWithoutInspecting(outcome: ToolOutcome): ReviewResult {
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toMatch(/^E_PATH_OUTSIDE_ROOT: /);

  const review = asReview(outcome);
  expect(review.ok).toBe(false);
  expect(review.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "E_PATH_OUTSIDE_ROOT",
  ]);
  // Nothing was read: no HEAD, no base, no files, no commands.
  expect(review.repository.head.sha).toBeNull();
  expect(review.repository.base).toBeNull();
  expect(review.changes.counts.distinctFiles).toBe(0);
  expect(review.changes.files).toEqual([]);
  expect(review.validations).toEqual([]);
  return review;
}

const BENIGN: readonly string[] = ["node", "-e", "process.exit(0)"];

function operatorConfig(): InspectorConfig {
  return {
    validations: {
      unit: { argv: [...BENIGN], description: "the operator's own test command" },
      withheld: { argv: [...BENIGN], description: "defined but not exposed over MCP" },
    },
    mcp: { allowValidations: ["unit"] },
  };
}

// ---------------------------------------------------------------------------

describe("MCP path confinement", () => {
  let repo: RepoHandle;
  let session: Session;

  beforeEach(async () => {
    // Confinement root is the temp directory; the repository lives inside it.
    repo = await makeRepo("project");
    await repo.write("README.md", "# project\n");
    await repo.commit("initial");
    session = await connect(repo.root, operatorConfig());
  });

  afterEach(async () => {
    await session.close();
    await repo.cleanup();
  });

  it("refuses an absolute path outside the root and inspects nothing", async () => {
    const outcome = narrow(
      await session.client.callTool({
        name: TOOL_INSPECT,
        arguments: { repo_path: "/etc" },
      }),
    );
    expectRefusedWithoutInspecting(outcome);
  });

  it("refuses a relative path that climbs out of the root", async () => {
    const outcome = narrow(
      await session.client.callTool({
        name: TOOL_INSPECT,
        arguments: { repo_path: "../../etc" },
      }),
    );
    expectRefusedWithoutInspecting(outcome);
  });

  it("refuses an absolute path that climbs out via .. segments", async () => {
    const outcome = narrow(
      await session.client.callTool({
        name: TOOL_INSPECT,
        arguments: { repo_path: path.join(repo.dir, "..", "..", "..") },
      }),
    );
    expectRefusedWithoutInspecting(outcome);
  });

  it("refuses a SYMLINK inside the root that points outside it", async () => {
    // The reason realpath is mandatory. Lexically, `<root>/escape-hatch` is
    // squarely inside the root; only symlink resolution reveals otherwise.
    const outside = await makeRepo("elsewhere");
    try {
      await outside.write("secrets.env", "AWS_SECRET_ACCESS_KEY=hunter2\n");
      await outside.commit("secrets");

      const link = path.join(repo.root, "escape-hatch");
      await fs.symlink(outside.dir, link, "dir");

      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: link },
        }),
      );

      const review = expectRefusedWithoutInspecting(outcome);
      // Nothing about the linked-to repository may leak, not even its path.
      expect(JSON.stringify(review)).not.toContain("secrets.env");
      expect(review.repository.path).not.toContain("elsewhere");
    } finally {
      await outside.cleanup();
    }
  });

  it("refuses a symlink to a NON-repository outside the root", async () => {
    // Pins the pre-flight realpath specifically. When the link points at another
    // Git repository, the post-inspection containment re-check would catch the
    // escape even if realpath were dropped from the pre-flight — so this case
    // links to a plain directory, where the only two possible answers are
    // E_PATH_OUTSIDE_ROOT (refused before reading) and E_NOT_A_REPO (read it).
    const outsideRoot = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "inspector-out-"));
    try {
      await fs.writeFile(path.join(outsideRoot, "id_rsa"), "PRIVATE KEY\n", "utf8");
      const link = path.join(repo.root, "plain-hatch");
      await fs.symlink(outsideRoot, link, "dir");

      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: link },
        }),
      );
      expectRefusedWithoutInspecting(outcome);
      expect(outcome.text).not.toContain("E_NOT_A_REPO");
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses a sibling whose name merely shares the root's prefix", async () => {
    // The `target.startsWith(root)` bug, isolated: for root `<tmp>/project`,
    // `<tmp>/project-evil` shares the prefix but is an unrelated directory.
    const prefixRoot = repo.dir;
    const evil = `${repo.dir}-evil`;
    await fs.mkdir(evil, { recursive: true });
    await repo.run("init", "-q", evil);
    await fs.writeFile(path.join(evil, "loot.txt"), "attacker owned\n", "utf8");
    await repo.run("-C", evil, "-c", "commit.gpgsign=false", "add", "-A");
    await repo.run("-C", evil, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "loot");

    const confined = await connect(prefixRoot, operatorConfig());
    try {
      // Sanity: the root itself is legitimately inspectable, so a blanket
      // refusal would make this test vacuous.
      const allowed = narrow(
        await confined.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: prefixRoot },
        }),
      );
      expect(allowed.isError).toBe(false);

      const outcome = narrow(
        await confined.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: evil },
        }),
      );
      const review = expectRefusedWithoutInspecting(outcome);
      expect(JSON.stringify(review)).not.toContain("loot.txt");
    } finally {
      await confined.close();
    }
  });

  it("refuses a directory inside the root whose repository root is outside it", async () => {
    // `git rev-parse --show-toplevel` walks *upward*. A path that passes the
    // pre-flight check can therefore still resolve to a repository the caller
    // was never allowed to see, so containment is re-checked after inspection.
    const inner = path.join(repo.dir, "packages", "app");
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(inner, "index.ts"), "export {};\n", "utf8");

    const confined = await connect(inner, operatorConfig());
    try {
      const outcome = narrow(
        await confined.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: inner },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/^E_PATH_OUTSIDE_ROOT: /);
      // The review that was produced is discarded rather than returned: nothing
      // about the enclosing repository (its HEAD, its files) may leak.
      const review = asReview(outcome);
      expect(review.repository.head.sha).toBeNull();
      expect(review.changes.files).toEqual([]);
      expect(JSON.stringify(review)).not.toContain("README.md");
    } finally {
      await confined.close();
    }
  });

  it("still inspects a legitimate path inside the root", async () => {
    // The control. A confinement check that refuses everything is not a
    // security property, it is an outage.
    const outcome = narrow(
      await session.client.callTool({
        name: TOOL_INSPECT,
        arguments: { repo_path: repo.dir },
      }),
    );
    expect(outcome.isError).toBe(false);
    expect(asReview(outcome).repository.path).toBe(await fs.realpath(repo.dir));
  });
});

// ---------------------------------------------------------------------------

describe("MCP execution policy", () => {
  let repo: RepoHandle;
  let marker: string;

  beforeEach(async () => {
    repo = await makeRepo("project");
    marker = path.join(repo.root, "PWNED.txt");
    await repo.write("README.md", "# project\n");
    await repo.commit("initial");

    // The confused-deputy payload: a repository that names its own commands.
    await repo.write(
      "inspector.config.json",
      `${JSON.stringify(
        {
          validations: {
            hostile: {
              argv: [
                "node",
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pwned")`,
              ],
            },
          },
          mcp: { allowValidations: ["hostile"] },
        },
        null,
        2,
      )}\n`,
    );
    // Left uncommitted on purpose: this is what an agent finds after cloning and
    // running an install script, and it is the state a working-tree inspector
    // must handle. Committing it would only change which scope it appears in.
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("never reads a repository-supplied config, and the hostile command never runs", async () => {
    const session = await connect(repo.root, operatorConfig());
    try {
      // The hostile name is not even advertised.
      const { tools } = await session.client.listTools();
      expect(JSON.stringify(tools)).not.toContain("hostile");
      expect(JSON.stringify(tools)).toContain("unit");

      // Asking for it by name is refused.
      const denied = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["hostile"] },
        }),
      );
      expect(denied.isError).toBe(true);

      // Plain inspection sees the file as data and does not act on it.
      const inspected = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: repo.dir },
        }),
      );
      expect(inspected.isError).toBe(false);
      expect(asReview(inspected).changes.files.map((file) => file.path)).toContain(
        "inspector.config.json",
      );

      // Running the operator's own allowlisted command must not pull the
      // repository's definitions in alongside it.
      const legitimate = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["unit"] },
        }),
      );
      expect(legitimate.isError).toBe(false);
      expect(asReview(legitimate).validations.map((v) => v.id)).toEqual(["unit"]);
    } finally {
      await session.close();
    }

    // The assertion that actually matters: the side effect never happened.
    expect(await exists(marker)).toBe(false);
  });

  it("loadConfig with allowRepoConfig:false — the setting the MCP entry point uses — ignores it loudly", async () => {
    // Documents the boundary the server entry point depends on: the repo config
    // is not merely unused, its presence is reported rather than swallowed.
    const loaded = await loadConfig({
      repositoryPath: repo.dir,
      allowRepoConfig: false,
    });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.sourcePath).toBeNull();
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "W_REPO_CONFIG_IGNORED",
    );
  });

  it("denies a validation defined by the operator but absent from mcp.allowValidations", async () => {
    const session = await connect(repo.root, operatorConfig());
    try {
      const schema = JSON.stringify(
        (await session.client.listTools()).tools.find(
          (tool) => tool.name === TOOL_RUN_VALIDATIONS,
        ),
      );
      expect(schema).not.toContain("withheld");

      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["withheld"] },
        }),
      );
      expect(outcome.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("does not register run_validations at all when nothing is allowlisted", async () => {
    const session = await connect(repo.root, {
      validations: { unit: { argv: [...BENIGN] } },
      mcp: { allowValidations: [] },
    });
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([TOOL_INSPECT]);

      // And it is genuinely absent, not merely hidden from the listing.
      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_RUN_VALIDATIONS,
          arguments: { repo_path: repo.dir, validations: ["unit"] },
        }),
      );
      expect(outcome.isError).toBe(true);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe("MCP error message hygiene", () => {
  let repo: RepoHandle;
  let session: Session;

  beforeEach(async () => {
    repo = await makeRepo("project");
    await repo.write("a.txt", "a\n");
    await repo.commit("initial");
    session = await connect(repo.root, operatorConfig());
  });

  afterEach(async () => {
    await session.close();
    await repo.cleanup();
  });

  it("never returns a stack trace on any error path", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: TOOL_INSPECT, arguments: { repo_path: "/etc" } },
      { name: TOOL_INSPECT, arguments: { repo_path: path.join(repo.root, "missing") } },
      { name: TOOL_INSPECT, arguments: { repo_path: repo.dir, base_ref: "nope" } },
      { name: TOOL_INSPECT, arguments: { repo_path: 17 } },
      { name: TOOL_INSPECT, arguments: {} },
      {
        name: TOOL_RUN_VALIDATIONS,
        arguments: { repo_path: repo.dir, validations: ["not-a-thing"] },
      },
    ];

    for (const call of calls) {
      const outcome = narrow(await session.client.callTool(call));
      expect(outcome.isError, `${call.name} ${JSON.stringify(call.arguments)}`).toBe(true);
      expect(outcome.text.length).toBeGreaterThan(0);

      // A thrown error's message reaches the model verbatim, so it is an
      // untrusted output surface: no frames, no source files, no internals.
      expect(outcome.text).not.toMatch(/\n\s*at\s+\S+\s*\(/);
      expect(outcome.text).not.toContain("node_modules");
      expect(outcome.text).not.toContain("/src/mcp/");
      expect(outcome.text).not.toMatch(/\.ts:\d+:\d+/);
      expect(outcome.text).not.toContain("ZodError");
    }
  });

  it("echoes only the caller's own path, never a resolved filesystem location", async () => {
    const outside = await makeRepo("elsewhere");
    try {
      const link = path.join(repo.root, "hatch");
      await fs.symlink(outside.dir, link, "dir");

      const outcome = narrow(
        await session.client.callTool({
          name: TOOL_INSPECT,
          arguments: { repo_path: link },
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("hatch");
      // Resolving the symlink is what proved the escape; disclosing where it
      // pointed would hand the caller information it could not otherwise get.
      expect(outcome.text).not.toContain(outside.dir);
      expect(outcome.text).not.toContain("elsewhere");
    } finally {
      await outside.cleanup();
    }
  });

  it("keeps a fatal error's code machine-readable at the head of the text", async () => {
    const outcome = narrow(
      await session.client.callTool({
        name: TOOL_INSPECT,
        arguments: { repo_path: "/etc" },
      }),
    );
    const [head] = outcome.text.split("\n");
    expect(head).toMatch(/^E_[A-Z_]+: /);
  });
});
