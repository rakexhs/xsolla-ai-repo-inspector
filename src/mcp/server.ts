#!/usr/bin/env node
/**
 * The stdio entry point.
 *
 * Everything interesting lives in `factory.ts`; this file is deliberately thin.
 * It parses launch flags, resolves the operator's allowlist, builds the server
 * and connects a transport — and it is the *only* place a transport is
 * connected, which is what makes the factory importable from a test.
 *
 * Two rules govern this file:
 *
 *  - **stdout belongs to JSON-RPC.** Every diagnostic goes to stderr. A single
 *    stray `console.log` here corrupts the protocol stream and manifests as an
 *    unparseable-message error in the client, far from its cause.
 *  - **Trust is fixed at launch.** The config is loaded with
 *    `allowRepoConfig: false`. MCP accepts validation names only; no launch
 *    option or tool argument can add an ad-hoc command capability.
 */
import path from "node:path";
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EXIT_CODES } from "../core/errors.js";
import { loadConfig } from "../validation/config.js";
import { createServer } from "./factory.js";

type Options = {
  root: string;
  configPath: string | undefined;
};

const USAGE = `inspector-mcp — MCP stdio server for the AI repo inspector

Usage: inspector-mcp [options]

Options:
  --root <dir>       Confinement root. Every repo_path a tool receives must
                     resolve (after symlink resolution) inside this directory.
                     Default: the current working directory.
  --config <file>    Operator-controlled validation allowlist. Without it the
                     server can inspect but cannot execute anything, and the
                     run_validations tool is not advertised at all.
  -h, --help         Print this message.

A repository-local inspector.config.json is never read on this surface: the
repository path is chosen by the model, so the repository must not be able to
decide what may be executed.`;

function fail(message: string): never {
  process.stderr.write(`inspector-mcp: ${message}\n`);
  process.exit(EXIT_CODES.USAGE);
}

/** Accepts both `--flag value` and `--flag=value`. */
function parseArgs(argv: readonly string[]): Options {
  let root: string | undefined;
  let configPath: string | undefined;

  const valueOf = (arg: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      if (inline.length === 0) fail(`${arg} requires a non-empty value`);
      return [inline, index];
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      fail(`${arg} requires a value; use ${arg}=<value> when it begins with '-'`);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) continue;
    const eq = raw.indexOf("=");
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);

    switch (flag) {
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(EXIT_CODES.OK);
      // eslint-disable-next-line no-fallthrough -- process.exit above is terminal.
      case "--root": {
        const [value, next] = valueOf(flag, inline, i);
        root = value;
        i = next;
        break;
      }
      case "--config": {
        const [value, next] = valueOf(flag, inline, i);
        configPath = value;
        i = next;
        break;
      }
      default:
        fail(`unknown option ${JSON.stringify(raw)}. Try --help.`);
    }
  }

  return {
    // Documented default: the process's working directory. An operator who
    // launches the server from a workspace root gets confinement to that
    // workspace without having to say so.
    root: path.resolve(root ?? process.cwd()),
    configPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { explicitPath: options.configPath } : {}),
    // Never true here. See the file header.
    allowRepoConfig: false,
  });

  for (const diagnostic of loaded.diagnostics) {
    process.stderr.write(`inspector-mcp: ${diagnostic.code}: ${diagnostic.message}\n`);
  }
  if (loaded.diagnostics.some((diagnostic) => diagnostic.severity === "fatal")) {
    process.exit(EXIT_CODES.USAGE);
  }

  const server = createServer({ root: options.root, config: loaded.config });

  process.stderr.write(
    `inspector-mcp: root=${options.root} config=${loaded.sourcePath ?? "(none)"} ` +
      `allowlisted=${loaded.config.mcp.allowValidations.length}\n`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // One line, no stack: stderr of an MCP server is often surfaced to a user.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`inspector-mcp: fatal: ${message.split("\n")[0] ?? "unknown error"}\n`);
  process.exit(EXIT_CODES.INTERNAL);
});
