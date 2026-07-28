/**
 * Byte-level tests for the two `-z` parsers.
 *
 * These feed exact wire strings rather than running Git, because the point is
 * to pin the framing rules — including the two that a plausible-looking
 * implementation gets wrong: the three-token rename record in `diff`, and the
 * *reversed* pairing order of the same record in `status --porcelain`.
 */
import { describe, expect, it } from "vitest";

import { parseNameStatusZ, parsePorcelainZ } from "../../src/git/parse.js";

const NUL = "\0";
/** Builds a NUL-terminated stream, the way Git actually emits one. */
const z = (...tokens: string[]): string =>
  tokens.length === 0 ? "" : tokens.join(NUL) + NUL;

describe("parseNameStatusZ", () => {
  it("returns an empty array for empty input", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("parses a plain add / modify / delete sequence", () => {
    const raw = z("A", "added.txt", "M", "modified.txt", "D", "deleted.txt");
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "added.txt", status: "added" },
      { path: "modified.txt", status: "modified" },
      { path: "deleted.txt", status: "deleted" },
    ]);
  });

  it("tolerates a trailing NUL and an input with no trailing NUL", () => {
    const terminated = "A\0only.txt\0";
    const unterminated = "A\0only.txt";
    const expected = [{ path: "only.txt", status: "added" }];
    expect(parseNameStatusZ(terminated)).toEqual(expected);
    expect(parseNameStatusZ(unterminated)).toEqual(expected);
  });

  it("parses a rename as three tokens with OLD before NEW", () => {
    // The exact byte string from the spec.
    const raw = "R100\0old.txt\0new.txt\0";
    expect(parseNameStatusZ(raw)).toEqual([
      {
        path: "new.txt",
        status: "renamed",
        origPath: "old.txt",
        score: 100,
      },
    ]);
  });

  it("parses a copy with a partial similarity score", () => {
    const raw = z("C75", "source.txt", "copy.txt");
    expect(parseNameStatusZ(raw)).toEqual([
      {
        path: "copy.txt",
        status: "copied",
        origPath: "source.txt",
        score: 75,
      },
    ]);
  });

  it("omits score entirely when the status has no numeric suffix", () => {
    const [file] = parseNameStatusZ(z("R", "a.txt", "b.txt"));
    expect(file).toEqual({
      path: "b.txt",
      status: "renamed",
      origPath: "a.txt",
    });
    // Not merely undefined: the key must be absent so the JSON output and the
    // Zod schema (exactOptionalPropertyTypes) agree.
    expect(Object.hasOwn(file!, "score")).toBe(false);
  });

  it("does not let a rename desynchronise the records that follow it", () => {
    // The starter's split("\t")/join("\t") approach produced one corrupt path
    // here and lost the following entries.
    const raw = z(
      "M",
      "before.txt",
      "R090",
      "src/old name.txt",
      "src/new name.txt",
      "A",
      "after.txt",
    );
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "before.txt", status: "modified" },
      {
        path: "src/new name.txt",
        status: "renamed",
        origPath: "src/old name.txt",
        score: 90,
      },
      { path: "after.txt", status: "added" },
    ]);
  });

  it("preserves paths containing a space, a newline and non-ASCII bytes", () => {
    const spaced = "dir with space/file name.txt";
    const newline = "weird\nname.txt";
    const unicode = "docs/café/日本語 ✓.md";
    const raw = z("A", spaced, "M", newline, "D", unicode);
    expect(parseNameStatusZ(raw)).toEqual([
      { path: spaced, status: "added" },
      { path: newline, status: "modified" },
      { path: unicode, status: "deleted" },
    ]);
  });

  it("maps T and U, and falls back to modified for unknown letters", () => {
    const raw = z("T", "link.txt", "U", "conflict.txt", "X", "mystery.txt");
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "link.txt", status: "typechange" },
      { path: "conflict.txt", status: "unmerged" },
      { path: "mystery.txt", status: "modified" },
    ]);
  });

  it("discards a record truncated mid-stream rather than inventing a path", () => {
    // Rename status with only one following path.
    expect(parseNameStatusZ(z("A", "a.txt") + "R100\0dangling.txt\0")).toEqual([
      { path: "a.txt", status: "added" },
    ]);
  });

  it("clamps an out-of-range score into the schema's 0-100 window", () => {
    const [file] = parseNameStatusZ(z("R999", "a.txt", "b.txt"));
    expect(file?.score).toBe(100);
  });
});

describe("parsePorcelainZ", () => {
  it("returns empty lists for empty input", () => {
    expect(parsePorcelainZ("")).toEqual({ untracked: [], unmerged: [] });
  });

  it("extracts untracked entries and ignores ordinary tracked changes", () => {
    const raw = z("?? new.txt", " M tracked.txt", "A  staged.txt", "?? other.txt");
    const parsed = parsePorcelainZ(raw);
    expect(parsed.untracked).toEqual([
      { path: "new.txt", status: "untracked" },
      { path: "other.txt", status: "untracked" },
    ]);
    expect(parsed.unmerged).toEqual([]);
  });

  it("labels Git's opaque untracked directory marker", () => {
    expect(parsePorcelainZ(z("?? inner/")).untracked).toEqual([
      { path: "inner/", status: "untracked", kind: "directory" },
    ]);
  });

  it("keeps the cursor aligned across a rename entry (NEW then ORIG)", () => {
    // This is the regression that matters: porcelain emits the rename's
    // *original* path as a second token, in the opposite order from `git diff`.
    // Failing to consume it makes "old name.txt" be read as an `XY PATH`
    // record and every later entry shift by one.
    const raw = z("R  new name.txt", "old name.txt", "?? untracked.txt");
    const parsed = parsePorcelainZ(raw);
    expect(parsed.untracked).toEqual([
      { path: "untracked.txt", status: "untracked" },
    ]);
    expect(parsed.unmerged).toEqual([]);
  });

  it("keeps the cursor aligned across a copy entry too", () => {
    const raw = z("C  copy.txt", "source.txt", "?? after-copy.txt");
    expect(parsePorcelainZ(raw).untracked).toEqual([
      { path: "after-copy.txt", status: "untracked" },
    ]);
  });

  it("handles a rename recorded in the worktree column (Y = R)", () => {
    const raw = z(" R renamed.txt", "before.txt", "?? tail.txt");
    expect(parsePorcelainZ(raw).untracked).toEqual([
      { path: "tail.txt", status: "untracked" },
    ]);
  });

  it("recognises every unmerged status pair", () => {
    const codes = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
    const raw = z(...codes.map((code, i) => `${code} conflict-${i}.txt`));
    const parsed = parsePorcelainZ(raw);
    expect(parsed.unmerged.map((f) => f.path)).toEqual(
      codes.map((_, i) => `conflict-${i}.txt`),
    );
    expect(parsed.unmerged.every((f) => f.status === "unmerged")).toBe(true);
    expect(parsed.untracked).toEqual([]);
  });

  it("preserves spaces, newlines and non-ASCII in untracked paths", () => {
    const spaced = "dir with space/new file.txt";
    const newline = "line\nbreak.txt";
    const unicode = "ünïcødé/日本語.txt";
    const raw = z(`?? ${spaced}`, `?? ${newline}`, `?? ${unicode}`);
    expect(parsePorcelainZ(raw).untracked.map((f) => f.path)).toEqual([
      spaced,
      newline,
      unicode,
    ]);
  });

  it("tolerates a trailing NUL and skips malformed short entries", () => {
    expect(parsePorcelainZ("?? a.txt\0").untracked).toEqual([
      { path: "a.txt", status: "untracked" },
    ]);
    expect(parsePorcelainZ(z("??", "?? b.txt")).untracked).toEqual([
      { path: "b.txt", status: "untracked" },
    ]);
  });

  it("never reports an ignored entry as untracked", () => {
    // `!!` only appears with --ignored, which we never pass, but the parser
    // must not treat it as untracked if a caller ever does.
    expect(parsePorcelainZ(z("!! ignored.txt", "?? real.txt")).untracked).toEqual(
      [{ path: "real.txt", status: "untracked" }],
    );
  });
});
