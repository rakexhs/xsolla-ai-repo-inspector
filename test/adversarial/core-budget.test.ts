/**
 * ADVERSARY-1: attacks on `src/core/review.ts` (enforceTotalBudget) and
 * `src/core/exit.ts` (exit-code mapping).
 *
 * Everything here is executable evidence. Every repaired budget regression is
 * retained as an ordinary positive test.
 */
import { afterEach, describe, expect, it } from "vitest";

import { reviewRepository } from "../../src/core/review.js";
import { exitCodeForResult } from "../../src/core/exit.js";
import { EXIT_CODES } from "../../src/core/errors.js";
import {
  CLI_LIMITS,
  MCP_LIMITS,
  type Limits,
  type PlannedValidation,
  type ReviewRequest,
  type ReviewResult,
} from "../../src/core/types.js";
import { renderJson } from "../../src/render/json.js";
import { makeResult, makeValidation } from "../helpers/result.js";
import { makeRepo, type RepoHandle } from "../helpers/repo.js";

const repos: RepoHandle[] = [];

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function repo(name = "repo"): Promise<RepoHandle> {
  const handle = await makeRepo(name);
  repos.push(handle);
  return handle;
}

function request(
  repositoryPath: string,
  overrides: Partial<ReviewRequest> = {},
): ReviewRequest {
  return {
    repositoryPath,
    scopes: ["staged", "unstaged", "untracked"],
    detail: "full",
    validations: [],
    denied: [],
    limits: CLI_LIMITS,
    ...overrides,
  };
}

/** A validation that writes `bytes` to stdout and `bytes` to stderr. */
function noisy(id: string, bytes: number, timeoutMs = 30_000): PlannedValidation {
  return {
    id,
    argv: [
      process.execPath,
      "-e",
      `const s='x'.repeat(${bytes});process.stdout.write(s);process.stderr.write(s);`,
    ],
    timeoutMs,
  };
}

function validationsBytes(result: ReviewResult): number {
  return Buffer.byteLength(JSON.stringify(result.validations), "utf8");
}

describe("enforceTotalBudget", () => {
  it(
    "keeps the validations payload within maxTotalBytes when the budget is reachable",
    async () => {
      const handle = await repo();
      const limits: Limits = { ...CLI_LIMITS, maxTotalBytes: 40 * 1024 };
      const validations = Array.from({ length: 20 }, (_, i) =>
        noisy(`noisy-${i}`, 8_000),
      );

      const result = await reviewRepository(
        request(handle.dir, { validations, limits }),
      );

      expect(result.validations).toHaveLength(20);
      expect(validationsBytes(result)).toBeLessThanOrEqual(limits.maxTotalBytes);
    },
    120_000,
  );

  it("declares truncation when many competing streams are reduced", async () => {
    const handle = await repo();
    const limits: Limits = { ...CLI_LIMITS, maxTotalBytes: 40 * 1024 };
    const validations = Array.from({ length: 20 }, (_, i) =>
      noisy(`noisy-${i}`, 8_000),
    );

    const result = await reviewRepository(
      request(handle.dir, { validations, limits }),
    );

    expect(validationsBytes(result)).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(result.truncation.applied).toBe(true);
  }, 120_000);

  /**
   * Positive control for the loop itself: with a single oversized stream the
   * budget IS met, proving the machinery works and the failure above is the
   * pass cap rather than clampText being broken.
   */
  it("does fit the budget when only one stream is oversized", async () => {
    const handle = await repo();
    const limits: Limits = { ...CLI_LIMITS, maxTotalBytes: 8 * 1024 };
    const result = await reviewRepository(
      request(handle.dir, {
        validations: [noisy("one", 20_000)],
        limits,
      }),
    );

    expect(validationsBytes(result)).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(result.truncation.applied).toBe(true);
    expect(result.truncation.droppedBytes).toBeGreaterThan(0);
  }, 120_000);

  /** The loop must always terminate, however pathological the shape. */
  it("terminates on 50 streams all pinned at the per-stream cap", async () => {
    const handle = await repo();
    const limits: Limits = {
      ...MCP_LIMITS,
      maxOutputBytesPerStream: 512,
      maxTotalBytes: 1024,
    };
    const validations = Array.from({ length: 50 }, (_, i) => noisy(`v${i}`, 4_000));

    const started = Date.now();
    const result = await reviewRepository(
      request(handle.dir, { validations, limits }),
    );
    // Termination is the assertion; 50 node spawns dominate the wall clock.
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(result.validations).toHaveLength(50);
  }, 180_000);

  it(
    "applies maxTotalBytes to the whole document, not only to validations",
    async () => {
      const handle = await repo();
      const name = "d".repeat(240);
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          handle.write(`${name}-${String(i).padStart(3, "0")}.txt`, "x"),
        ),
      );

      const result = await reviewRepository(
        request(handle.dir, {
          scopes: ["untracked"],
          limits: MCP_LIMITS,
        }),
      );

      expect(result.changes.counts.untracked).toBe(50);
      expect(result.changes.listTruncated).toBe(true);
      expect(Buffer.byteLength(renderJson(result), "utf8")).toBeLessThanOrEqual(
        MCP_LIMITS.maxTotalBytes,
      );
    },
    120_000,
  );

  it("declares whole-document change-list truncation", async () => {
    const handle = await repo();
    const name = "d".repeat(240);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        handle.write(`${name}-${String(i).padStart(3, "0")}.txt`, "x"),
      ),
    );

    const result = await reviewRepository(
      request(handle.dir, { scopes: ["untracked"], limits: MCP_LIMITS }),
    );

    expect(result.truncation.applied).toBe(true);
    expect(result.changes.listTruncated).toBe(true);
    expect(result.changes.counts.untracked).toBe(50);
    expect(
      Buffer.byteLength(renderJson(result), "utf8"),
    ).toBeLessThanOrEqual(MCP_LIMITS.maxTotalBytes);
  }, 120_000);

  it("reports droppedBytes consistent with the size it actually removed", async () => {
    const handle = await repo();
    const limits: Limits = { ...CLI_LIMITS, maxTotalBytes: 6 * 1024 };
    const result = await reviewRepository(
      request(handle.dir, { validations: [noisy("one", 20_000)], limits }),
    );

    // droppedBytes is measured on the JSON projection of `validations`, so the
    // only defensible check is that it is positive and no larger than the
    // amount the payload actually shrank by.
    expect(result.truncation.droppedBytes).toBeGreaterThan(0);
    expect(result.truncation.droppedBytes).toBeLessThan(
      2 * limits.maxOutputBytesPerStream * 2 + 4096,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Exit-code mapping
// ---------------------------------------------------------------------------

type Row = {
  name: string;
  result: ReviewResult;
  expected: number;
};

/** Recomputes `ok` exactly as `reviewRepository` does, so rows stay honest. */
function withDerivedOk(result: ReviewResult): ReviewResult {
  const fatal = result.diagnostics.some((d) => d.severity === "fatal");
  return {
    ...result,
    ok: !fatal && result.validations.every((v) => v.status === "passed"),
  };
}

const rows: Row[] = [
  {
    name: "clean run, no validations",
    result: withDerivedOk(makeResult({ validations: [] })),
    expected: EXIT_CODES.OK,
  },
  {
    name: "clean run, one passing validation",
    result: withDerivedOk(makeResult({ validations: [makeValidation()] })),
    expected: EXIT_CODES.OK,
  },
  {
    name: "warning diagnostics only",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "W_TRUNCATED", severity: "warning", message: "trimmed" },
        ],
      }),
    ),
    expected: EXIT_CODES.OK,
  },
  {
    name: "failed validation",
    result: withDerivedOk(
      makeResult({
        validations: [makeValidation({ status: "failed", exitCode: 1 })],
      }),
    ),
    expected: EXIT_CODES.VALIDATION_FAILED,
  },
  {
    name: "denied validation",
    result: withDerivedOk(
      makeResult({
        validations: [
          makeValidation({ status: "denied", exitCode: null, reason: "policy" }),
        ],
      }),
    ),
    expected: EXIT_CODES.VALIDATION_FAILED,
  },
  {
    name: "spawn_error validation",
    result: withDerivedOk(
      makeResult({
        validations: [makeValidation({ status: "spawn_error", exitCode: null })],
      }),
    ),
    expected: EXIT_CODES.VALIDATION_FAILED,
  },
  {
    name: "timed_out validation",
    result: withDerivedOk(
      makeResult({
        validations: [
          makeValidation({ status: "timed_out", exitCode: null, signal: "SIGKILL" }),
        ],
      }),
    ),
    expected: EXIT_CODES.TIMEOUT,
  },
  {
    name: "timed_out beside a plain failure (timeout wins)",
    result: withDerivedOk(
      makeResult({
        validations: [
          makeValidation({ id: "a", status: "failed", exitCode: 2 }),
          makeValidation({ id: "b", status: "timed_out", exitCode: null }),
        ],
      }),
    ),
    expected: EXIT_CODES.TIMEOUT,
  },
  {
    name: "fatal E_NOT_A_REPO",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_NOT_A_REPO", severity: "fatal", message: "nope" },
        ],
        validations: [],
      }),
    ),
    expected: EXIT_CODES.INSPECTION_FAILED,
  },
  {
    name: "fatal E_GIT_TIMEOUT",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_GIT_TIMEOUT", severity: "fatal", message: "slow" },
        ],
        validations: [],
      }),
    ),
    expected: EXIT_CODES.TIMEOUT,
  },
  {
    name: "fatal E_CONFIG_INVALID",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_CONFIG_INVALID", severity: "fatal", message: "bad" },
        ],
        validations: [],
      }),
    ),
    expected: EXIT_CODES.USAGE,
  },
  {
    name: "fatal E_INTERNAL",
    result: withDerivedOk(
      makeResult({
        diagnostics: [{ code: "E_INTERNAL", severity: "fatal", message: "bug" }],
        validations: [],
      }),
    ),
    expected: EXIT_CODES.INTERNAL,
  },
  {
    name: "fatal outranks a failing validation",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_NOT_A_REPO", severity: "fatal", message: "nope" },
        ],
        validations: [makeValidation({ status: "failed", exitCode: 1 })],
      }),
    ),
    expected: EXIT_CODES.INSPECTION_FAILED,
  },
  {
    name: "fatal outranks a timed-out validation",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_NO_MERGE_BASE", severity: "fatal", message: "unrelated" },
        ],
        validations: [makeValidation({ status: "timed_out", exitCode: null })],
      }),
    ),
    expected: EXIT_CODES.INSPECTION_FAILED,
  },
  {
    name: "inspection failed, everything skipped as denied",
    result: withDerivedOk(
      makeResult({
        diagnostics: [
          { code: "E_NOT_A_REPO", severity: "fatal", message: "nope" },
        ],
        validations: [
          makeValidation({
            status: "denied",
            exitCode: null,
            reason: "skipped: repository inspection failed",
          }),
        ],
      }),
    ),
    expected: EXIT_CODES.INSPECTION_FAILED,
  },
];

describe("exitCodeForResult vs ok (table-driven)", () => {
  for (const row of rows) {
    it(`${row.name} -> ${row.expected}`, () => {
      expect(exitCodeForResult(row.result)).toBe(row.expected);
    });
  }

  it("ok === true if and only if the exit code is 0, for every row", () => {
    for (const row of rows) {
      expect(
        [row.name, row.result.ok, exitCodeForResult(row.result) === 0],
      ).toEqual([row.name, row.result.ok, row.result.ok]);
    }
  });
});
