/**
 * The documentation is part of the product, so it gets tests.
 *
 * The starter this project grew out of was seeded with defects of the form
 * "README claims something the repository does not do", and finding those was the
 * assignment. Two of them then reappeared in *this* repository, which is the
 * honest reason this file exists:
 *
 *  - the README quickstart told a reader to run
 *    `--config ./inspector.config.json`, and no such file was committed, so the
 *    first interesting command in the documentation exited 2;
 *  - the same example allowlisted `npm run lint`, and there is no `lint` script.
 *
 * Prose drifts from behaviour silently. These assertions make it drift loudly
 * instead. Everything here is checked against a *generated* source of truth —
 * the parser's own flag list, `package.json`, the real config loader — rather
 * than a second hand-maintained list that could rot in the same way.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_FLAGS } from "../../src/cli/args.js";
import { loadConfig } from "../../src/validation/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relPath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relPath), "utf8");
}

async function readJson(relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(relPath)) as Record<string, unknown>;
}

describe("README documents the real CLI surface", () => {
  it("mentions every flag the parser accepts", async () => {
    const readme = await read("README.md");
    for (const flag of ALL_FLAGS) {
      // Sourced from the parser, so a new flag fails here until it is documented.
      expect(readme, `README.md must document ${flag}`).toContain(flag);
    }
  });

  it("does not hardcode a test count that rots on the next commit", async () => {
    // "411 tests" was true for exactly one commit. A number that must be
    // hand-updated to stay true is a defect with a delay on it.
    for (const file of ["README.md", "SUBMISSION.md"]) {
      const text = await read(file);
      expect(text, `${file} should not pin an exact test count`).not.toMatch(
        /\b\d{3,}\s+tests\b/,
      );
    }
  });

  it("references only test paths that exist", async () => {
    const readme = await read("README.md");
    const referenced = new Set(
      [...readme.matchAll(/`(test\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1] ?? ""),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const relPath of referenced) {
      await expect(
        fs.access(path.join(repoRoot, relPath)),
        `README.md references ${relPath}`,
      ).resolves.toBeUndefined();
    }
  });
});

describe("the committed example config is real", () => {
  it("exists and loads through the actual config loader", async () => {
    // Not `JSON.parse` plus hope: the same code path the CLI uses, so a schema
    // change that invalidates the example fails here.
    const result = await loadConfig({
      explicitPath: path.join(repoRoot, "inspector.config.json"),
      allowRepoConfig: false,
    });

    expect(result.diagnostics.filter((d) => d.severity === "fatal")).toEqual([]);
    expect(Object.keys(result.config.validations).length).toBeGreaterThan(0);
  });

  it("names only npm scripts that package.json actually defines", async () => {
    // This is the `npm run lint` defect, turned into an assertion.
    const config = await readJson("inspector.config.json");
    const pkg = await readJson("package.json");
    const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
    const validations = (config["validations"] ?? {}) as Record<
      string,
      { argv: string[] }
    >;

    for (const [name, entry] of Object.entries(validations)) {
      const [command, sub, script] = entry.argv;
      expect(command, `${name} should invoke npm`).toBe("npm");
      if (sub === "run") {
        expect(
          scripts,
          `inspector.config.json validation "${name}" runs "npm run ${script}", which package.json does not define`,
        ).toHaveProperty(script as string);
      } else {
        // `npm test` is a lifecycle script; assert it resolves too.
        expect(scripts, `${name} runs "npm ${sub}"`).toHaveProperty(sub as string);
      }
    }
  });

  it("allowlists only validation names it also defines", async () => {
    const config = await readJson("inspector.config.json");
    const validations = Object.keys(
      (config["validations"] ?? {}) as Record<string, unknown>,
    );
    const mcp = (config["mcp"] ?? {}) as { allowValidations?: string[] };

    for (const name of mcp.allowValidations ?? []) {
      expect(
        validations,
        `mcp.allowValidations names "${name}", which is not a defined validation`,
      ).toContain(name);
    }
  });
});

describe("package manifest matches what the docs promise", () => {
  it("declares the bin targets the README tells people to run", async () => {
    const pkg = await readJson("package.json");
    const bin = (pkg["bin"] ?? {}) as Record<string, string>;
    const readme = await read("README.md");

    for (const name of Object.keys(bin)) {
      expect(readme, `README.md should mention the ${name} binary`).toContain(name);
    }
    expect(bin).toHaveProperty("inspector");
    expect(bin).toHaveProperty("inspector-mcp");
  });

  it("keeps the documented Node floor and the engines field in agreement", async () => {
    const pkg = await readJson("package.json");
    const engines = (pkg["engines"] ?? {}) as { node?: string };
    const floor = (engines.node ?? "").replace(/^>=\s*/, "");

    expect(floor).not.toBe("");
    const readme = await read("README.md");
    expect(readme, `README.md should state the Node floor ${floor}`).toContain(floor);
  });
});
