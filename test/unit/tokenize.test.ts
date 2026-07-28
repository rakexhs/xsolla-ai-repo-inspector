import { describe, expect, it } from "vitest";
import { tokenizeCommand } from "../../src/validation/tokenize.js";

/** Narrows to the success arm, failing the test with the error if it is not. */
function expectOk(input: string): string[] {
  const result = tokenizeCommand(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to tokenize: ${result.error}`);
  return result.argv;
}

function expectError(input: string): string {
  const result = tokenizeCommand(input);
  if (result.ok) {
    throw new Error(
      `expected ${JSON.stringify(input)} to be rejected, got ${JSON.stringify(result.argv)}`,
    );
  }
  return result.error;
}

describe("tokenizeCommand — accepted syntax", () => {
  it("splits on whitespace", () => {
    expect(expectOk("npm run test:unit")).toEqual(["npm", "run", "test:unit"]);
  });

  it("collapses runs of spaces and tabs", () => {
    expect(expectOk("  npm \t  run   lint  ")).toEqual(["npm", "run", "lint"]);
  });

  it("keeps a single-quoted section as one token", () => {
    expect(expectOk("git commit -m 'hello world'")).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
    ]);
  });

  it("keeps a double-quoted section as one token", () => {
    expect(expectOk('prog --msg "two words"')).toEqual(["prog", "--msg", "two words"]);
  });

  it('honours \\" and \\\\ escapes inside double quotes', () => {
    expect(expectOk('prog "say \\"hi\\""')).toEqual(["prog", 'say "hi"']);
    expect(expectOk('prog "back\\\\slash"')).toEqual(["prog", "back\\slash"]);
  });

  it("treats a backslash as literal inside single quotes", () => {
    expect(expectOk("prog 'a\\b'")).toEqual(["prog", "a\\b"]);
  });

  it("produces an empty-string argument from an empty quoted token", () => {
    expect(expectOk("prog ''")).toEqual(["prog", ""]);
  });

  it("allows adjacent quoted and unquoted fragments to join", () => {
    expect(expectOk("prog --flag='a b'")).toEqual(["prog", "--flag=a b"]);
  });
});

describe("tokenizeCommand — shell metacharacters are refused, never passed through", () => {
  // The whole point: a silently mis-executed command is worse than a refusal,
  // because the user believes the part after the operator ran.
  const cases: ReadonlyArray<[label: string, input: string, char: string]> = [
    ["semicolon", "npm test; rm -rf /", ";"],
    ["chaining with &&", "npm test && npm run lint", "&"],
    ["background &", "npm test &", "&"],
    ["pipe", "npm test | tee out.log", "|"],
    ["command substitution $(...)", "echo $(whoami)", "$"],
    ["variable expansion", "echo $HOME", "$"],
    ["backtick substitution", "echo `whoami`", "`"],
    ["output redirection", "npm test > out.log", ">"],
    ["input redirection", "prog < in.txt", "<"],
    ["glob star", "rm *.log", "*"],
    ["glob question mark", "ls file?.txt", "?"],
    ["bracket glob", "ls file[0-9].txt", "["],
    ["brace expansion", "ls {a,b}.txt", "{"],
    ["tilde expansion", "cat ~/secrets", "~"],
    ["history bang", "prog !!", "!"],
    ["comment hash", "npm test # skip", "#"],
    ["subshell parens", "(npm test)", "("],
  ];

  for (const [label, input, char] of cases) {
    it(`rejects ${label}`, () => {
      const error = expectError(input);
      expect(error).toContain(`'${char}'`);
      expect(error).toContain("no shell");
    });
  }

  it("rejects a literal newline", () => {
    const error = expectError("npm test\nrm -rf /");
    expect(error).toContain("newline");
  });

  it("rejects a NUL byte", () => {
    const error = expectError(`npm${String.fromCharCode(0)}test`);
    expect(error).toContain("NUL");
  });

  it("names the offending character and its position", () => {
    const error = expectError("npm test; ls");
    expect(error).toContain("';'");
    expect(error).toContain("position 8");
  });

  it("rejects a metacharacter even when it is quoted", () => {
    // Quoting only groups whitespace here. Allowing `"a && b"` through would
    // make safety depend on quoting subtleties; an argv array in the config is
    // the supported way to pass such a character literally.
    expect(expectError("prog 'a && b'")).toContain("'&'");
    expect(expectError('prog "$HOME"')).toContain("'$'");
  });
});

describe("tokenizeCommand — malformed input", () => {
  it("rejects an empty string", () => {
    expect(expectError("")).toContain("empty");
  });

  it("rejects whitespace-only input", () => {
    expect(expectError("   \t  ")).toContain("empty");
  });

  it("rejects an unterminated single quote", () => {
    expect(expectError("prog 'unterminated")).toContain("unterminated single quote");
  });

  it("rejects an unterminated double quote", () => {
    expect(expectError('prog "unterminated')).toContain("unterminated double quote");
  });

  it("rejects a trailing escaped quote that never closes", () => {
    expect(expectError('prog "a\\"')).toContain("unterminated double quote");
  });
});
