/**
 * Pure parsers for Git's NUL-delimited machine formats.
 *
 * Everything in this file is a total function of its input string: no I/O, no
 * clock, no environment. That is deliberate — these are the two places where a
 * subtle mistake corrupts every downstream number, so they must be exhaustively
 * unit-testable without a repository.
 *
 * Why `-z` everywhere: without it Git C-quotes any path containing a space, a
 * quote, a backslash, a newline or a non-ASCII byte (`"src/\303\251.txt"`), and
 * the consumer has to reimplement C string unescaping. With `-z` the bytes are
 * literal and the only delimiter is NUL, which cannot occur in a POSIX path.
 * **There is therefore no unquoting code below, and there must never be.**
 */
import type { ChangedFile, FileStatus } from "../core/types.js";

/**
 * Splits a NUL-delimited stream into tokens.
 *
 * Git terminates (rather than separates) records, so a well-formed stream ends
 * with a trailing NUL and produces a final empty token. Empty tokens are never
 * meaningful — a path is never the empty string — so dropping them here makes
 * both a trailing NUL and an entirely empty stream fall out for free.
 */
function tokenize(raw: string): string[] {
  if (raw.length === 0) return [];
  return raw.split("\0").filter((token) => token.length > 0);
}

/** Maps a `--name-status` letter to our closed status vocabulary. */
function statusFromLetter(letter: string): FileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "unmerged";
    default:
      // `X` (unknown, "probably a bug") and `B` (pairing broken) are the only
      // other letters Git emits. Reporting them as a modification is honest
      // enough for a change list and keeps the vocabulary closed.
      return "modified";
  }
}

/**
 * Parses the digits trailing a rename/copy status (`R100` -> 100).
 *
 * Absent or malformed suffixes yield `undefined` rather than 0, because 0 is a
 * meaningful similarity score and "not reported" is not the same as "0% alike".
 */
function parseScore(code: string): number | undefined {
  const digits = code.slice(1);
  if (digits.length === 0 || !/^\d+$/.test(digits)) return undefined;
  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value)) return undefined;
  // The schema constrains score to 0-100; clamp rather than emit invalid data.
  return Math.min(100, Math.max(0, value));
}

/**
 * Parses `git diff --name-status -z` output.
 *
 * Wire format is `STATUS\0PATH\0` repeated, **except** that a status beginning
 * with `R` or `C` emits three tokens: `STATUS\0OLDPATH\0NEWPATH\0`.
 *
 * This is implemented as an explicit token cursor rather than a per-record
 * split for exactly that reason. The starter split each record on TAB and
 * re-joined the remainder, which silently produced a single bogus path
 * (`old.txt\tnew.txt`) for every rename — and TABs are not even present in `-z`
 * output, so the rename pair was never recovered at all.
 */
export function parseNameStatusZ(raw: string): ChangedFile[] {
  const tokens = tokenize(raw);
  const files: ChangedFile[] = [];

  let cursor = 0;
  while (cursor < tokens.length) {
    const code = tokens[cursor];
    cursor += 1;
    if (code === undefined) break;

    const letter = code.charAt(0);
    const isPair = letter === "R" || letter === "C";

    // A pair record needs two more tokens; a plain record needs one. A stream
    // truncated mid-record is discarded rather than guessed at.
    const firstPath = tokens[cursor];
    if (firstPath === undefined) break;
    cursor += 1;

    if (isPair) {
      const secondPath = tokens[cursor];
      if (secondPath === undefined) break;
      cursor += 1;

      // diff order: OLD then NEW. (Porcelain is the other way round — see
      // parsePorcelainZ.)
      const file: ChangedFile = {
        path: secondPath,
        status: statusFromLetter(letter),
        origPath: firstPath,
      };
      const score = parseScore(code);
      // exactOptionalPropertyTypes: the key must be absent, not set to
      // undefined, when there is no score.
      if (score !== undefined) file.score = score;
      files.push(file);
      continue;
    }

    files.push({ path: firstPath, status: statusFromLetter(letter) });
  }

  return files;
}

/** The seven two-letter combinations Git uses for a conflicted path. */
const UNMERGED_CODES: ReadonlySet<string> = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

export type PorcelainEntries = {
  untracked: ChangedFile[];
  unmerged: ChangedFile[];
};

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=normal` output.
 *
 * Wire format is `XY PATH\0` per entry: two status characters, one space, then
 * the path (no quoting, because of `-z`).
 *
 * **The trap:** when `X` or `Y` is `R` or `C`, porcelain emits a second token
 * holding the *original* path — and the pairing order is the reverse of
 * `git diff`'s. Porcelain gives `XY NEW\0ORIG\0`; diff gives `OLD\0NEW\0`.
 *
 * We only extract untracked and unmerged entries here, so a rename entry
 * carries no information we need. We must still *consume* its extra token: skip
 * that and the cursor desynchronises, after which the original path of the
 * rename is parsed as if it were an `XY PATH` record and every subsequent entry
 * is misread. `test/unit/git-parse.test.ts` pins this with a rename immediately
 * followed by an untracked file.
 */
export function parsePorcelainZ(raw: string): PorcelainEntries {
  const tokens = tokenize(raw);
  const untracked: ChangedFile[] = [];
  const unmerged: ChangedFile[] = [];

  let cursor = 0;
  while (cursor < tokens.length) {
    const entry = tokens[cursor];
    cursor += 1;
    if (entry === undefined) break;
    // "XY " plus at least one path character.
    if (entry.length < 4) continue;

    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const xy = `${x}${y}`;
    const path = entry.slice(3);

    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // Consume the original-path token so the cursor stays aligned.
      cursor += 1;
      continue;
    }

    if (xy === "??") {
      untracked.push({
        path,
        status: "untracked",
        ...(path.endsWith("/") ? { kind: "directory" as const } : {}),
      });
      continue;
    }

    if (UNMERGED_CODES.has(xy)) {
      unmerged.push({ path, status: "unmerged" });
    }
  }

  return { untracked, unmerged };
}
