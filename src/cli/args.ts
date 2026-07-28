/**
 * Command-line parsing, isolated from every side effect.
 *
 * `parseArgs` is a pure function over an argv array: it reads nothing from the
 * environment, touches no filesystem, prints nothing, and never throws. Every
 * failure comes back as a `Diagnostic` with code `E_ARGS`. That is what makes
 * the whole surface testable without spawning a process, and it is why the
 * three parser defects below are regressions rather than manual checks.
 *
 * The defects this module exists to prevent, all reproduced in the starter:
 *
 *  1. **A missing flag value became `undefined`.** `args.validations.push(
 *     argv[++index])` pushed `undefined` past the type system, which then blew
 *     up deep inside `child_process` with `ERR_INVALID_ARG_TYPE` — *and the
 *     process still exited 0*, so CI went green on a crash. `strict` plus
 *     `noUncheckedIndexedAccess` now makes that shape a compile error, and a
 *     missing value is reported here as a usage error instead.
 *  2. **Values were split on whitespace.** `argv[++index]?.split(" ")[0]` meant
 *     `--repo "/Users/me/My Repos/app"` silently became `/Users/me/My`. Values
 *     are taken verbatim, always. Splitting a value is never correct: the shell
 *     already did the word splitting.
 *  3. **Unknown input was ignored.** A typo'd flag was skipped, so the user got
 *     a report that quietly did not do what they asked. Unknown flags, unknown
 *     subcommands and unknown enum values are all hard errors that name the
 *     accepted alternatives.
 *
 * One deliberate strictness beyond the brief: in the `--flag value` form a
 * value beginning with `-` is refused, because `--repo --format json` is far
 * more likely to be a forgotten argument than a directory literally named
 * `--format`. `--flag=value` bypasses the check, so a genuine leading dash is
 * still expressible.
 */

import type { Diagnostic } from "../core/errors.js";
import { DETAIL_LEVELS, SCOPES, type DetailLevel, type Scope } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export const OUTPUT_FORMATS = ["markdown", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** A fully-resolved `review` invocation. Defaults are already applied. */
export type ReviewArgs = {
  mode: "review";
  /** Verbatim as typed; not resolved, not canonicalised. */
  repo: string;
  /** Absent means auto-detect. */
  baseRef?: string;
  /** Deduplicated and ordered canonically, so argv order cannot change output. */
  scopes: Scope[];
  detail: DetailLevel;
  format: OutputFormat;
  /** `"-"` means stdout. */
  out: string;
  /** Ad-hoc `--validate` command strings, in the order given. */
  validate: string[];
  /** Named `--validation` entries, in the order given. */
  validation: string[];
  config?: string;
  allowRepoConfig: boolean;
  /** Trust the repository's own git config, including keys git executes. */
  allowRepoExecConfig: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
  exitZero: boolean;
  debug: boolean;
};

export type ParsedArgs = { mode: "help" } | { mode: "version" } | ReviewArgs;

export type ParseOutcome =
  | { ok: true; args: ParsedArgs }
  | { ok: false; diagnostic: Diagnostic };

// ---------------------------------------------------------------------------
// Option table
// ---------------------------------------------------------------------------

/** Long options that consume a value. */
const VALUE_FLAGS = [
  "--repo",
  "--base-ref",
  "--scope",
  "--detail",
  "--format",
  "--out",
  "--validate",
  "--validation",
  "--config",
  "--max-output-bytes",
  "--timeout",
] as const;

/** Options that are present or absent and never take a value. */
const BOOLEAN_FLAGS = [
  "--allow-repo-config",
  "--allow-repo-exec-config",
  "--exit-zero",
  "--debug",
  "--help",
  "-h",
  "--version",
  "-v",
] as const;

const VALUE_FLAG_SET: ReadonlySet<string> = new Set(VALUE_FLAGS);
const BOOLEAN_FLAG_SET: ReadonlySet<string> = new Set(BOOLEAN_FLAGS);

/** Every accepted flag, for the "unknown flag" message. */
export const ALL_FLAGS: readonly string[] = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort();

export const SUBCOMMANDS = ["review"] as const;

/**
 * Scope aliases. `worktree` is the "what have I not committed?" question an
 * agent asks constantly, and spelling it out three times every invocation is
 * the kind of friction that leads people to just use the default.
 */
const SCOPE_ALIASES: Readonly<Record<string, readonly Scope[]>> = {
  worktree: ["staged", "unstaged", "untracked"],
  all: [...SCOPES],
};

const SCOPE_VALUES: readonly string[] = [...SCOPES, ...Object.keys(SCOPE_ALIASES)];

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

type ParseFailure = { ok: false; diagnostic: Diagnostic };

function argsError(message: string, hint?: string): ParseFailure {
  // `exactOptionalPropertyTypes`: an absent hint must be an absent *key*.
  const diagnostic: Diagnostic = { code: "E_ARGS", severity: "fatal", message };
  if (hint !== undefined) diagnostic.hint = hint;
  return { ok: false, diagnostic };
}

function list(values: readonly string[]): string {
  return values.join(", ");
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

/**
 * Positive integers only, and only in plain decimal.
 *
 * `Number("1e9")`, `Number(" 12 ")` and `Number("0x10")` all succeed, and
 * `parseInt("12abc")` returns 12. Every one of those would silently accept a
 * typo as a limit, so the shape is checked before the conversion.
 */
type NumberOutcome = { ok: true; value: number } | ParseFailure;

function parsePositiveInteger(flag: string, raw: string): NumberOutcome {
  if (!/^[0-9]+$/.test(raw)) {
    return argsError(
      `${flag} expects a positive integer, got ${JSON.stringify(raw)}`,
      "Pass a plain decimal number of milliseconds or bytes, for example --timeout 30000.",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return argsError(
      `${flag} expects a positive integer, got ${JSON.stringify(raw)}`,
      "The value must be greater than zero and below 2^53.",
    );
  }
  return { ok: true, value };
}

function parseScopeList(raw: string, into: Set<Scope>): ParseFailure | null {
  const segments = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return argsError(
      `--scope expects a comma-separated list, got ${JSON.stringify(raw)}`,
      `Accepted values: ${list(SCOPE_VALUES)}.`,
    );
  }

  for (const segment of segments) {
    const alias = SCOPE_ALIASES[segment];
    if (alias !== undefined) {
      for (const scope of alias) into.add(scope);
      continue;
    }
    if ((SCOPES as readonly string[]).includes(segment)) {
      into.add(segment as Scope);
      continue;
    }
    return argsError(
      `--scope: unknown value ${JSON.stringify(segment)}`,
      `Accepted values: ${list(SCOPE_VALUES)}.`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

type Accumulator = {
  repo: string | undefined;
  baseRef: string | undefined;
  scopes: Set<Scope>;
  scopeSeen: boolean;
  detail: DetailLevel;
  format: OutputFormat;
  out: string;
  validate: string[];
  validation: string[];
  config: string | undefined;
  allowRepoConfig: boolean;
  allowRepoExecConfig: boolean;
  maxOutputBytes: number | undefined;
  timeoutMs: number | undefined;
  exitZero: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
};

/**
 * Parses argv (already stripped of `node` and the script path).
 *
 * Never throws. Returns either a fully-defaulted `ParsedArgs` or exactly one
 * `E_ARGS` diagnostic describing the first problem found — one problem, because
 * a wrong `--scope` usually means the rest of the line is guesswork too.
 */
export function parseArgs(argv: readonly string[]): ParseOutcome {
  const state: Accumulator = {
    repo: undefined,
    baseRef: undefined,
    scopes: new Set<Scope>(),
    scopeSeen: false,
    detail: "full",
    format: "markdown",
    out: "-",
    validate: [],
    validation: [],
    config: undefined,
    allowRepoConfig: false,
    allowRepoExecConfig: false,
    maxOutputBytes: undefined,
    timeoutMs: undefined,
    exitZero: false,
    debug: false,
    help: false,
    version: false,
  };

  const positionals: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // `noUncheckedIndexedAccess` makes this `string | undefined`; a bounded
    // loop cannot actually produce undefined, but the check is free.
    if (token === undefined) break;

    if (optionsEnded) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    // A bare "-" is a positional (and the conventional spelling of stdout).
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // Split `--flag=value` once, so a value may itself contain `=`.
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    if (BOOLEAN_FLAG_SET.has(name)) {
      if (inlineValue !== undefined) {
        return argsError(
          `${name} does not take a value (got ${JSON.stringify(token)})`,
          "Pass the flag on its own.",
        );
      }
      switch (name) {
        case "--allow-repo-config":
          state.allowRepoConfig = true;
          break;
        case "--allow-repo-exec-config":
          state.allowRepoExecConfig = true;
          break;
        case "--exit-zero":
          state.exitZero = true;
          break;
        case "--debug":
          state.debug = true;
          break;
        case "--help":
        case "-h":
          state.help = true;
          break;
        case "--version":
        case "-v":
          state.version = true;
          break;
        default:
          break;
      }
      continue;
    }

    if (!VALUE_FLAG_SET.has(name)) {
      return argsError(
        `unknown option ${JSON.stringify(name)}`,
        `Valid options: ${list(ALL_FLAGS)}.`,
      );
    }

    // Resolve the value. This is the block the starter got wrong twice.
    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = argv[index + 1];
      if (next === undefined) {
        return argsError(
          `${name} requires a value but none was given`,
          `Usage: ${name} <value>.`,
        );
      }
      if (next.startsWith("-") && next !== "-") {
        return argsError(
          `${name} requires a value but was followed by ${JSON.stringify(next)}`,
          `If the value really begins with a dash, write ${name}=<value>.`,
        );
      }
      // Verbatim. No trimming, no splitting, no shell semantics.
      value = next;
      index += 1;
    }

    switch (name) {
      case "--repo":
        state.repo = value;
        break;
      case "--base-ref":
        state.baseRef = value;
        break;
      case "--scope": {
        state.scopeSeen = true;
        const failure = parseScopeList(value, state.scopes);
        if (failure !== null) return failure;
        break;
      }
      case "--detail": {
        if (!(DETAIL_LEVELS as readonly string[]).includes(value)) {
          return argsError(
            `--detail: unknown value ${JSON.stringify(value)}`,
            `Accepted values: ${list(DETAIL_LEVELS)}.`,
          );
        }
        state.detail = value as DetailLevel;
        break;
      }
      case "--format": {
        if (!(OUTPUT_FORMATS as readonly string[]).includes(value)) {
          return argsError(
            `--format: unknown value ${JSON.stringify(value)}`,
            `Accepted values: ${list(OUTPUT_FORMATS)}.`,
          );
        }
        state.format = value as OutputFormat;
        break;
      }
      case "--out":
        state.out = value;
        break;
      case "--validate":
        state.validate.push(value);
        break;
      case "--validation":
        state.validation.push(value);
        break;
      case "--config":
        state.config = value;
        break;
      case "--max-output-bytes": {
        const parsed = parsePositiveInteger(name, value);
        if (!parsed.ok) return parsed;
        state.maxOutputBytes = parsed.value;
        break;
      }
      case "--timeout": {
        const parsed = parsePositiveInteger(name, value);
        if (!parsed.ok) return parsed;
        state.timeoutMs = parsed.value;
        break;
      }
      default:
        break;
    }
  }

  // --help and --version are answers in themselves and outrank everything,
  // including a missing subcommand: `inspector --help` must work.
  if (state.help) return { ok: true, args: { mode: "help" } };
  if (state.version) return { ok: true, args: { mode: "version" } };

  const subcommand = positionals[0];
  if (subcommand === undefined) {
    return argsError(
      "no subcommand given",
      `Expected: ${list(SUBCOMMANDS)}. Run "inspector --help" for usage.`,
    );
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return argsError(
      `unknown subcommand ${JSON.stringify(subcommand)}`,
      `Expected: ${list(SUBCOMMANDS)}. Run "inspector --help" for usage.`,
    );
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return argsError(
      `unexpected argument ${JSON.stringify(extra)}`,
      "Every value must be attached to a flag; this tool takes no positional operands.",
    );
  }

  if (state.repo === undefined) {
    return argsError("--repo is required", "Usage: inspector review --repo <path>.");
  }

  // Canonical order, so `--scope unstaged,committed` and `--scope
  // committed,unstaged` produce byte-identical reports.
  const scopes: Scope[] = state.scopeSeen
    ? SCOPES.filter((scope) => state.scopes.has(scope))
    : [...SCOPES];

  const args: ReviewArgs = {
    mode: "review",
    repo: state.repo,
    scopes,
    detail: state.detail,
    format: state.format,
    out: state.out,
    validate: state.validate,
    validation: state.validation,
    allowRepoConfig: state.allowRepoConfig,
    allowRepoExecConfig: state.allowRepoExecConfig,
    exitZero: state.exitZero,
    debug: state.debug,
  };
  // Optional keys are added only when present: under
  // `exactOptionalPropertyTypes`, `{ baseRef: undefined }` is not assignable to
  // `{ baseRef?: string }`.
  if (state.baseRef !== undefined) args.baseRef = state.baseRef;
  if (state.config !== undefined) args.config = state.config;
  if (state.maxOutputBytes !== undefined) args.maxOutputBytes = state.maxOutputBytes;
  if (state.timeoutMs !== undefined) args.timeoutMs = state.timeoutMs;

  return { ok: true, args };
}
