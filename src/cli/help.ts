/**
 * Usage text and version string.
 *
 * The version is read from `package.json` at runtime rather than baked into a
 * constant. A hardcoded version is guaranteed to be wrong eventually — it goes
 * stale the first time `npm version` bumps the manifest and nobody remembers
 * this file — and "the binary reports a version that does not exist" is a
 * genuinely expensive bug to debug in the field.
 *
 * Resolution has to work from two different depths:
 *   - `src/cli/help.ts` when run through tsx, and
 *   - `dist/cli/help.js` after `tsc` (outDir `dist`, rootDir `src`).
 *
 * Both happen to be two levels below the package root today, but relying on
 * that coincidence means a future `outDir` change silently breaks `--version`.
 * So the lookup walks up from this module until it finds a `package.json` with
 * a `version`, and falls back to a marker string rather than throwing: failing
 * to print a version must never take the whole CLI down.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DETAIL_LEVELS, SCOPES } from "../core/types.js";
import { OUTPUT_FORMATS } from "./args.js";

const UNKNOWN_VERSION = "0.0.0-unknown";

/** Walks up from this module to the nearest readable `package.json` version. */
function readVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));

  // Bounded: `path.dirname("/")` is `"/"`, so the loop terminates at the root
  // even on a path with no package.json anywhere above it.
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = path.join(directory, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === "string" && version.length > 0) return version;
      }
    } catch {
      // Not here, or not readable: keep walking.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return UNKNOWN_VERSION;
}

/** The package name, resolved alongside the version. Purely cosmetic. */
export const PROGRAM_NAME = "inspector";

export function versionText(): string {
  return `${PROGRAM_NAME} ${readVersion()}`;
}

/**
 * Full usage. Every flag the parser accepts appears here exactly once, spelled
 * exactly as `args.ts` spells it, and nothing that is not a flag is written in
 * flag form — a test asserts this text and the README agree.
 */
export function helpText(): string {
  return `${PROGRAM_NAME} — inspect Git changes and run allowlisted validations

Usage:
  inspector review --repo <path> [options]
  inspector --help
  inspector --version

Options:
  --repo <path>            Repository to inspect. Required.
  --base-ref <ref>         Base ref for the committed scope. Default: auto-detect.
  --scope <list>           Comma-separated. Values: ${SCOPES.join(", ")},
                           plus aliases "worktree" (= staged,unstaged,untracked)
                           and "all". Default: all.
  --detail <level>         ${DETAIL_LEVELS.join(" | ")}. Default: full.
  --format <fmt>           ${OUTPUT_FORMATS.join(" | ")}. Default: markdown.
  --out <path>             Write the report to a file. "-" means stdout. Default: "-".
  --validate <command>     Ad-hoc command string, repeatable. No shell.
  --validation <name>      Named validation from the config, repeatable.
  --config <path>          Operator config file.
  --allow-repo-config      Permit loading <repo>/inspector.config.json.
  --max-output-bytes <n>   Per-stream output cap. Default from CLI_LIMITS.
  --timeout <ms>           Per-validation timeout. Default from CLI_LIMITS.
  --exit-zero              Exit 0 whenever a report was produced.
  --debug                  Include stack traces for internal errors only.
  -h, --help               Print help and exit 0.
  -v, --version            Print the version and exit 0.

Exit codes:
  0   Review completed; nothing failed.
  1   Review completed; at least one validation failed.
  2   The caller invoked the tool incorrectly.
  3   The repository could not be inspected.
  4   A time budget was exceeded.
  70  Unexpected internal error.

Examples:
  inspector review --repo .
  inspector review --repo "/path/with spaces/app" --scope worktree
  inspector review --repo . --format json --out report.json
  inspector review --repo . --config ./inspector.config.json --validation unit
`;
}

/** One line, printed to stderr after a usage error. */
export function helpHint(): string {
  return `Run "${PROGRAM_NAME} --help" for usage.`;
}
