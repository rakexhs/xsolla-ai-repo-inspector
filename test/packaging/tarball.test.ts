/**
 * Packaging tests.
 *
 * The starter's `npm run build` exited 0 while `package.json#bin` pointed at
 * `./dist/cli.js`, a file the build never produced (`rootDir: "."` emitted
 * `dist/src/cli.js`). Typecheck, build and tests all passed; the published
 * binary simply did not exist.
 *
 * Nothing short of actually packing the tarball, installing it somewhere else
 * and executing the declared binary catches that class of defect. These tests
 * are slow for that reason, and the slowness is the point.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const packageJson = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { version: string; bin: Record<string, string>; files: string[] };

/** Generous: this suite runs a real build, a real pack and a real install. */
const SLOW = 300_000;

let workdir: string;
let tarball: string;

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

describe("packaging", () => {
  beforeAll(async () => {
    // Build from scratch so the assertions describe a real, reproducible build
    // rather than whatever happened to be left in dist/.
    const build = await run("npm", ["run", "build"], REPO_ROOT);
    expect(build.code, `npm run build failed:\n${build.stderr}`).toBe(0);

    workdir = await mkdtemp(path.join(tmpdir(), "inspector-pack-"));
    const packed = await run(
      "npm",
      ["pack", "--pack-destination", workdir, "--silent"],
      REPO_ROOT,
    );
    expect(packed.code, `npm pack failed:\n${packed.stderr}`).toBe(0);
    tarball = path.join(workdir, packed.stdout.trim().split("\n").pop() ?? "");
    expect(existsSync(tarball), `tarball not found at ${tarball}`).toBe(true);
  }, SLOW);

  afterAll(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("produces every binary declared in package.json#bin", () => {
    for (const target of Object.values(packageJson.bin)) {
      const resolved = path.join(REPO_ROOT, target);
      expect(
        existsSync(resolved),
        `package.json#bin declares ${target} but the build did not produce it`,
      ).toBe(true);
    }
  });

  it("marks the built entry points executable", () => {
    // tsc preserves the shebang but does not set the executable bit; the
    // postbuild step does. Without it, running ./dist/cli/main.js from a local
    // build fails with EACCES.
    for (const target of Object.values(packageJson.bin)) {
      const mode = readFileSync(path.join(REPO_ROOT, target)).length;
      expect(mode).toBeGreaterThan(0);
      const stat = require("node:fs").statSync(path.join(REPO_ROOT, target));
      expect(stat.mode & 0o111, `${target} is not executable`).toBeGreaterThan(0);
    }
  });

  it("keeps the shebang on the compiled entry points", () => {
    for (const target of Object.values(packageJson.bin)) {
      const first = readFileSync(path.join(REPO_ROOT, target), "utf8").split("\n")[0];
      expect(first).toBe("#!/usr/bin/env node");
    }
  });

  it("does not ship tests or sources in the tarball", async () => {
    const listed = await run("tar", ["-tzf", tarball], workdir);
    expect(listed.code).toBe(0);
    const entries = listed.stdout.split("\n").filter(Boolean);

    expect(entries.some((e) => e.startsWith("package/dist/"))).toBe(true);
    // The starter compiled test/ into dist/ and would have published it.
    expect(entries.filter((e) => e.includes(".test."))).toEqual([]);
    expect(entries.filter((e) => e.startsWith("package/test/"))).toEqual([]);
    expect(entries.filter((e) => e.startsWith("package/src/"))).toEqual([]);
    expect(entries.filter((e) => e.includes(".agent-work"))).toEqual([]);
  });

  it(
    "installs into a clean project and runs the declared binary",
    async () => {
      const consumer = await mkdtemp(path.join(tmpdir(), "inspector-consumer-"));
      try {
        await writeFile(
          path.join(consumer, "package.json"),
          JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
        );

        const installed = await run(
          "npm",
          ["install", "--silent", "--no-audit", "--no-fund", tarball],
          consumer,
        );
        expect(installed.code, `install failed:\n${installed.stderr}`).toBe(0);

        const binary = path.join(consumer, "node_modules", ".bin", "inspector");
        expect(existsSync(binary), "inspector bin was not linked").toBe(true);

        // Executing the linked binary is the assertion that would have caught
        // the starter's broken bin path.
        const version = await run(binary, ["--version"], consumer);
        expect(version.code).toBe(0);
        expect(version.stdout).toContain(packageJson.version);

        const help = await run(binary, ["--help"], consumer);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain("--repo");

        const mcpBinary = path.join(
          consumer,
          "node_modules",
          ".bin",
          "inspector-mcp",
        );
        expect(existsSync(mcpBinary), "inspector-mcp bin was not linked").toBe(true);

        const mcpHelp = await run(mcpBinary, ["--help"], consumer);
        expect(mcpHelp.code).toBe(0);
        expect(mcpHelp.stdout).toContain("--root");
        expect(mcpHelp.stdout).not.toContain("--allow-ad-hoc");

        const removedCapability = await run(
          mcpBinary,
          ["--allow-ad-hoc"],
          consumer,
        );
        expect(removedCapability.code).toBe(2);
        expect(removedCapability.stderr).toContain("unknown option");
      } finally {
        await rm(consumer, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
