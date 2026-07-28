import { describe, expect, it } from "vitest";

import { ReviewResultSchema } from "../../src/core/types.js";
import { renderJson, toStructuredContent } from "../../src/render/json.js";
import { makeChangedFile, makeFailingValidation, makeResult, makeValidation } from "../helpers/result.js";

describe("test fixture", () => {
  it("baseline result satisfies the schema", () => {
    expect(() => ReviewResultSchema.parse(makeResult())).not.toThrow();
  });
});

describe("toStructuredContent", () => {
  it("round-trips through ReviewResultSchema", () => {
    // This is the property the MCP SDK depends on: it validates
    // `structuredContent` against the advertised `outputSchema` and throws an
    // McpError if it does not conform.
    const result = makeResult({
      ok: false,
      changes: {
        committed: [makeChangedFile("b.ts", "renamed", { origPath: "a.ts", score: 92 })],
        listTruncated: true,
      },
      validations: [makeValidation(), makeFailingValidation()],
      diagnostics: [
        { code: "E_VALIDATION_FAILED", severity: "error", message: "lint failed", hint: "run eslint --fix" },
        { code: "W_DETACHED_HEAD", severity: "warning", message: "HEAD is detached" },
      ],
      truncation: { applied: true, droppedBytes: 512, fields: ["validations.0.stdout"] },
    });

    const structured = toStructuredContent(result);
    const parsed = ReviewResultSchema.parse(structured);
    expect(parsed).toEqual(result);
  });

  it("round-trips a result with a null base and an unborn HEAD", () => {
    const result = makeResult({
      repository: {
        head: { unborn: true, detached: false, sha: null, branch: null },
        base: null,
      },
      changes: { committed: [], staged: [], unstaged: [], untracked: [] },
      diagnostics: [{ code: "W_NO_COMMITS", severity: "warning", message: "repository has no commits" }],
    });

    expect(() => ReviewResultSchema.parse(toStructuredContent(result))).not.toThrow();
    expect(toStructuredContent(result)["repository"]).toMatchObject({ base: null });
  });

  it("omits absent optionals entirely rather than emitting null", () => {
    const result = makeResult({
      changes: { committed: [makeChangedFile("plain.ts", "modified")], staged: [], unstaged: [], untracked: [] },
      validations: [makeValidation()], // no `reason`
      diagnostics: [{ code: "W_NO_BASE_REF", severity: "warning", message: "no base" }], // no `hint`
    });

    const json = JSON.parse(JSON.stringify(toStructuredContent(result))) as Record<string, unknown>;
    const changes = json["changes"] as Record<string, unknown>;
    const file = (changes["committed"] as Record<string, unknown>[])[0]!;
    const validation = (json["validations"] as Record<string, unknown>[])[0]!;
    const diagnostic = (json["diagnostics"] as Record<string, unknown>[])[0]!;

    expect(Object.keys(file)).toEqual(["path", "status"]);
    expect("origPath" in file).toBe(false);
    expect("score" in file).toBe(false);
    expect("reason" in validation).toBe(false);
    expect("hint" in diagnostic).toBe(false);

    // A null would be a schema violation, not merely ugly.
    expect(renderJson(result)).not.toContain("null,\n      \"score\"");
  });

  it("includes present optionals", () => {
    const result = makeResult({
      changes: {
        committed: [makeChangedFile("new.ts", "copied", { origPath: "old.ts", score: 75 })],
        staged: [],
        unstaged: [],
        untracked: [],
      },
      validations: [makeValidation({ status: "denied", exitCode: null, reason: "not on the allowlist" })],
      diagnostics: [{ code: "E_VALIDATION_DENIED", severity: "error", message: "denied", hint: "add to allowlist" }],
    });

    const json = toStructuredContent(result);
    const file = (json["changes"] as { committed: Record<string, unknown>[] }).committed[0]!;
    expect(file).toEqual({ path: "new.ts", status: "copied", origPath: "old.ts", score: 75 });
    expect((json["validations"] as Record<string, unknown>[])[0]).toMatchObject({
      reason: "not on the allowlist",
    });
    expect((json["diagnostics"] as Record<string, unknown>[])[0]).toMatchObject({
      hint: "add to allowlist",
    });
  });

  it("preserves per-stream dropped-byte accounting", () => {
    const result = makeResult({
      validations: [
        makeValidation({
          truncated: { stdout: true, stderr: false },
          outputBytesDropped: { stdout: 4096, stderr: 0 },
        }),
      ],
      truncation: {
        applied: true,
        droppedBytes: 4096,
        fields: ["validations[0].stdout"],
      },
    });
    const validation = (
      toStructuredContent(result)["validations"] as Record<string, unknown>[]
    )[0];
    expect(validation?.["outputBytesDropped"]).toEqual({
      stdout: 4096,
      stderr: 0,
    });
  });

  it("preserves an opaque directory marker in scoped and summary output", () => {
    const result = makeResult({
      changes: {
        committed: [],
        staged: [],
        unstaged: [],
        untracked: [
          makeChangedFile("inner/", "untracked", { kind: "directory" }),
        ],
      },
    });

    const changes = toStructuredContent(result)["changes"] as {
      untracked: Record<string, unknown>[];
      files: Record<string, unknown>[];
    };
    expect(changes.untracked[0]).toMatchObject({ kind: "directory" });
    expect(changes.files[0]).toMatchObject({ kind: "directory" });
  });

  it("produces a deterministic key order across calls", () => {
    const result = makeResult({ validations: [makeValidation(), makeFailingValidation()] });

    const first = toStructuredContent(result);
    const second = toStructuredContent(result);

    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "ok",
      "detail",
      "scopes",
      "repository",
      "changes",
      "validations",
      "diagnostics",
      "truncation",
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("orders keys independently of the insertion order of the input object", () => {
    // Build a structurally identical result whose own key insertion order is
    // reversed; the projection must erase that difference.
    const canonical = makeResult();
    const shuffledEntries = Object.entries(canonical).reverse();
    const shuffled = Object.fromEntries(shuffledEntries) as typeof canonical;

    expect(Object.keys(shuffled)[0]).not.toBe("schemaVersion");
    expect(renderJson(shuffled)).toBe(renderJson(canonical));
  });

  it("returns a value free of undefined and of prototype pollution vectors", () => {
    const structured = toStructuredContent(makeResult());
    const serialised = JSON.stringify(structured);
    expect(serialised).not.toContain("undefined");
    // A structural clone must be identical: nothing non-JSON survived.
    expect(JSON.parse(serialised)).toEqual(structured);
  });
});

describe("renderJson", () => {
  it("ends with exactly one trailing newline and parses", () => {
    const text = renderJson(makeResult());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(() => ReviewResultSchema.parse(JSON.parse(text))).not.toThrow();
  });

  it("uses a two-space indent", () => {
    const text = renderJson(makeResult());
    expect(text.split("\n")[1]).toMatch(/^ {2}"schemaVersion": 1,$/);
  });

  it("is byte-identical across repeated renders", () => {
    const result = makeResult({ validations: [makeFailingValidation()] });
    expect(renderJson(result)).toBe(renderJson(result));
  });
});
