/**
 * Command-string tokenisation for the *ad-hoc* validation path.
 *
 * The runner never uses a shell (see `run.ts`), so a command string has to be
 * turned into an argv array here. That creates a specific hazard: if a user
 * types `npm test && npm run lint` and we naively split on whitespace, the
 * literal string `&&` is handed to `npm` as an argument. The command "succeeds"
 * in the sense that something ran, the user believes their chained command
 * executed, and the second half silently never happened. A misleading pass is
 * strictly worse than a loud refusal, so anything resembling shell syntax is
 * rejected up front.
 *
 * Supported syntax is deliberately tiny:
 *   - whitespace separates tokens
 *   - single quotes group verbatim
 *   - double quotes group, honouring only the escapes \" and \\
 *
 * Everything else that a shell would treat as special is an error.
 */

/**
 * Characters a POSIX shell would interpret. Each one is rejected because
 * without a shell it either (a) reaches the program as a literal when the user
 * expected expansion (`*`, `?`, `~`, `[`, `]`, `{`, `}`), or (b) expresses
 * control flow / redirection / substitution that simply cannot happen
 * (`;`, `&`, `|`, `<`, `>`, `` ` ``, `$`, `(`, `)`, `!`, `#`).
 */
const SHELL_METACHARACTERS: ReadonlySet<string> = new Set([
  ";",
  "&",
  "|",
  "`",
  "$",
  "(",
  ")",
  "<",
  ">",
  "{",
  "}",
  "*",
  "?",
  "[",
  "]",
  "!",
  "~",
  "#",
]);

/**
 * The NUL byte, built with fromCharCode so that no literal control character
 * ever has to appear in this source file.
 */
const NUL = String.fromCharCode(0);

/** Human-readable names for characters that would print badly in an error. */
const CHARACTER_NAMES: ReadonlyMap<string, string> = new Map([
  ["\n", "newline"],
  ["\r", "carriage return"],
  [NUL, "NUL"],
]);

export type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: string };

function describeCharacter(char: string): string {
  const name = CHARACTER_NAMES.get(char);
  return name ?? `'${char}'`;
}

function metacharacterError(char: string, index: number): string {
  return (
    `unsupported shell metacharacter ${describeCharacter(char)} at position ${index}: ` +
    `validation commands are executed directly with no shell, so shell syntax ` +
    `(chaining, pipes, redirection, substitution, globbing, ~ expansion) is not supported ` +
    `and would otherwise be passed through as a literal argument. ` +
    `Define the command as an explicit argv array in the inspector config instead.`
  );
}

/**
 * Splits a command string into argv, or explains why it cannot be done safely.
 *
 * Quoting does **not** exempt a metacharacter. That is a deliberate choice: the
 * only thing quoting buys here is grouping whitespace, and a user who genuinely
 * needs `$` or `*` as a literal argument should declare the command as an argv
 * array in the operator-owned config, which bypasses this function entirely.
 * Allowing `"a && b"` through would mean the same input string is safe or
 * unsafe depending on quoting subtleties, which is exactly the kind of
 * ambiguity this layer exists to remove.
 */
export function tokenizeCommand(input: string): TokenizeResult {
  if (input.trim().length === 0) {
    return { ok: false, error: "command is empty: expected a program to run" };
  }

  // Scan the raw input first so the reported position matches what the user
  // typed, and so a metacharacter is reported even if the string also has an
  // unterminated quote further along.
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    if (SHELL_METACHARACTERS.has(char) || char === "\n" || char === "\r" || char === NUL) {
      return { ok: false, error: metacharacterError(char, i) };
    }
  }

  const argv: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        const next = input[i + 1];
        // Only \" and \\ are escapes inside double quotes; every other
        // backslash is literal, matching POSIX double-quote semantics.
        if (next === '"' || next === "\\") {
          current += next;
          i += 1;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasCurrent = true;
      continue;
    }

    if (char === " " || char === "\t" || char === "\v" || char === "\f") {
      if (hasCurrent) {
        argv.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }

    current += char;
    hasCurrent = true;
  }

  if (quote !== null) {
    const kind = quote === "'" ? "single" : "double";
    return {
      ok: false,
      error: `unterminated ${kind} quote: the command string ends inside a ${kind}-quoted section`,
    };
  }

  if (hasCurrent) argv.push(current);

  if (argv.length === 0) {
    return { ok: false, error: "command is empty: expected a program to run" };
  }

  const program = argv[0];
  if (program === undefined || program.length === 0) {
    return {
      ok: false,
      error: "command is empty: the first token is an empty string, so there is no program to run",
    };
  }

  return { ok: true, argv };
}
