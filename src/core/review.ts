/**
 * The review engine.
 *
 * This is the single place a review is produced. Both adapters — the CLI and
 * the MCP server — call this function and nothing else, which is what lets the
 * consistency test assert that the two interfaces genuinely share behaviour
 * rather than merely resembling each other.
 *
 * Trust decisions have already been made by the time a request arrives here:
 * `validations` are authorised argv arrays and `denied` records what was
 * refused and why. The engine never decides what is allowed to run.
 */
import { inspectRepository } from "../git/inspect.js";
import { runValidations } from "../validation/run.js";
import type { Diagnostic } from "./errors.js";
import { clampText } from "./text.js";
import {
  SCHEMA_VERSION,
  SCOPES,
  type ChangeSet,
  type ReviewRequest,
  type ReviewResult,
  type Scope,
  type TruncationInfo,
  type ValidationOutcome,
} from "./types.js";

/** A result shell used when the repository could not be inspected at all. */
function emptyChangeSet(): ChangeSet {
  return {
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
    files: [],
    counts: {
      committed: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      distinctFiles: 0,
    },
    listTruncated: false,
  };
}

/**
 * Collects the dotted paths of every field that was shortened upstream.
 *
 * Truncation is always self-declaring: a consumer that silently receives less
 * data than it believes it has is a correctness bug, not a cosmetic one.
 */
function collectTruncatedFields(
  changes: ChangeSet,
  validations: ValidationOutcome[],
): string[] {
  const fields: string[] = [];
  if (changes.listTruncated) fields.push("changes");
  validations.forEach((outcome, index) => {
    if (outcome.truncated.stdout) fields.push(`validations[${index}].stdout`);
    if (outcome.truncated.stderr) fields.push(`validations[${index}].stderr`);
  });
  return fields;
}

function upstreamDroppedBytes(validations: ValidationOutcome[]): number {
  return validations.reduce(
    (sum, outcome) =>
      sum +
      (outcome.outputBytesDropped?.stdout ?? 0) +
      (outcome.outputBytesDropped?.stderr ?? 0),
    0,
  );
}

const STREAM_KEYS = ["stdout", "stderr"] as const;
type StreamKey = (typeof STREAM_KEYS)[number];

function serialisedSize(value: unknown): number {
  // Match renderJson(): the documented cap applies to bytes a caller actually
  // receives, not to a smaller compact projection used only internally.
  return Buffer.byteLength(`${JSON.stringify(value, null, 2) ?? ""}\n`, "utf8");
}

/** Empties both captured streams, marking them truncated. */
function withEmptyStreams(outcome: ValidationOutcome): ValidationOutcome {
  return {
    ...outcome,
    stdout: "",
    stderr: "",
    truncated: {
      stdout: outcome.truncated.stdout || outcome.stdout.length > 0,
      stderr: outcome.truncated.stderr || outcome.stderr.length > 0,
    },
  };
}

/**
 * Distributes a byte allowance across competing streams by water-filling.
 *
 * Streams smaller than an equal share keep their full content and donate the
 * remainder to the larger ones, so a single chatty command cannot crowd out
 * nine quiet ones — and nine quiet ones cannot starve the one that actually
 * failed. Processing ascending by size makes one pass sufficient.
 */
function allocate(
  sizes: number[],
  available: number,
): number[] {
  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => a.size - b.size);

  const allowances = new Array<number>(sizes.length).fill(0);
  let remaining = Math.max(0, available);
  let left = order.length;

  for (const { size, index } of order) {
    if (left <= 0) break;
    const share = Math.floor(remaining / left);
    const give = Math.min(size, share);
    allowances[index] = give;
    remaining -= give;
    left -= 1;
  }

  return allowances;
}

/**
 * Enforces the whole-result byte budget.
 *
 * Per-stream caps alone are not enough: ten validations each at their
 * individual cap still multiply into an oversized payload.
 *
 * Two defects found by adversarial testing shaped this implementation, and both
 * are worth stating because the naive version looks correct:
 *
 *  1. An earlier version shrank one stream per pass with a fixed 32-pass bound.
 *     With more than ~32 oversized streams it exited *still over budget* while
 *     `truncation.applied` claimed success — a silent contract violation. This
 *     version computes an allocation directly rather than iterating towards
 *     one, and only loops to correct for JSON escaping overhead.
 *  2. An earlier version measured only `validations`. `maxTotalBytes` is
 *     documented as a whole-document cap, so a large change set could blow it
 *     with no truncation declared at all. This version measures the entire
 *     result and will trim change lists as a last resort.
 */
function enforceTotalBudget(
  draft: ReviewResult,
  maxTotalBytes: number,
): { result: ReviewResult; droppedBytes: number } {
  const initialSize = serialisedSize(draft);
  if (initialSize <= maxTotalBytes) {
    return { result: draft, droppedBytes: 0 };
  }

  const original = draft.validations;
  let validations = original.map((outcome) => ({
    ...outcome,
    truncated: { ...outcome.truncated },
  }));

  // --- Phase 1: fit captured output into whatever the skeleton leaves over ---

  const skeletonSize = serialisedSize({
    ...draft,
    validations: validations.map(withEmptyStreams),
  });

  const flat: Array<{ index: number; key: StreamKey }> = [];
  for (const [index, outcome] of validations.entries()) {
    for (const key of STREAM_KEYS) {
      if (outcome[key].length > 0) flat.push({ index, key });
    }
  }

  if (skeletonSize >= maxTotalBytes) {
    // Even with no captured output the result does not fit; drop it all.
    validations = validations.map(withEmptyStreams);
  } else if (flat.length > 0) {
    let available = maxTotalBytes - skeletonSize;

    // JSON escaping inflates strings (a newline costs two bytes, a control
    // character six), so an allocation computed on raw byte lengths can still
    // overshoot once serialised. Re-measure and tighten. Each iteration
    // strictly reduces the allowance, so this terminates at zero in the worst
    // case rather than spinning.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sizes = flat.map(({ index, key }) =>
        Buffer.byteLength(original[index]?.[key] ?? "", "utf8"),
      );
      const allowances = allocate(sizes, available);

      validations = original.map((outcome) => ({
        ...outcome,
        truncated: { ...outcome.truncated },
      }));

      for (const [position, { index, key }] of flat.entries()) {
        const outcome = validations[index];
        const source = original[index]?.[key] ?? "";
        const allowance = allowances[position] ?? 0;
        if (outcome === undefined) continue;
        if (allowance >= Buffer.byteLength(source, "utf8")) continue;

        const clamped = clampText(source, {
          maxBytes: allowance,
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        outcome[key] = clamped.text;
        outcome.truncated[key] = true;
      }

      if (serialisedSize({ ...draft, validations }) <= maxTotalBytes) break;
      if (available === 0) break;
      available = Math.floor(available / 2);
    }
  }

  // --- Phase 2: last resort, trim the change lists themselves ---

  let changes = draft.changes;
  let listTrimmed = false;

  // Counts are deliberately left at their pre-truncation values so a consumer
  // can always see how much it is not being shown.
  for (
    let guard = 0;
    guard < 10_000 &&
    serialisedSize({ ...draft, validations, changes }) > maxTotalBytes;
    guard += 1
  ) {
    const scopes = SCOPES.filter((scope) => changes[scope].length > 0);
    const longest = scopes.reduce<Scope | null>(
      (best, scope) =>
        best === null || changes[scope].length > changes[best].length
          ? scope
          : best,
      null,
    );

    if (longest === null) {
      if (changes.files.length === 0) break;
      changes = {
        ...changes,
        files: changes.files.slice(0, Math.floor(changes.files.length / 2)),
        listTruncated: true,
      };
      listTrimmed = true;
      continue;
    }

    // Halve rather than drop one at a time: a 5000-file change set would
    // otherwise take 5000 serialisations to converge.
    const kept = Math.floor(changes[longest].length / 2);
    changes = {
      ...changes,
      [longest]: changes[longest].slice(0, kept),
      files: changes.files.slice(
        0,
        Math.max(kept, Math.floor(changes.files.length / 2)),
      ),
      listTruncated: true,
    };
    listTrimmed = true;
  }

  const result: ReviewResult = {
    ...draft,
    validations,
    changes: listTrimmed ? { ...changes, listTruncated: true } : changes,
  };

  return {
    result,
    droppedBytes: Math.max(0, initialSize - serialisedSize(result)),
  };
}

export async function reviewRepository(
  request: ReviewRequest,
): Promise<ReviewResult> {
  const inspection = await inspectRepository({
    repositoryPath: request.repositoryPath,
    ...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
    scopes: request.scopes,
    maxFilesPerScope: request.limits.maxFilesPerScope,
    timeoutMs: request.limits.gitTimeoutMs,
  });

  const diagnostics: Diagnostic[] = [...inspection.diagnostics];
  const inspectionFailed = diagnostics.some((d) => d.severity === "fatal");

  let validations: ValidationOutcome[] = [];

  if (inspectionFailed) {
    // Deliberately do not execute anything when the repository could not be
    // inspected: the caller asked for a review of a specific repository, and
    // running commands against a directory we failed to understand would be
    // both useless and unsafe. Everything requested is still accounted for.
    validations = [...request.validations, ...request.denied].map((item) => ({
      id: item.id,
      argv: "argv" in item ? item.argv : [],
      status: "denied" as const,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      truncated: { stdout: false, stderr: false },
      reason: "skipped: repository inspection failed",
    }));
  } else {
    const run = await runValidations({
      validations: request.validations,
      denied: request.denied,
      cwd: inspection.repository.path,
      limits: request.limits,
    });
    validations = run.outcomes;
    diagnostics.push(...run.diagnostics);
  }

  // Assemble a draft so the budget pass can measure the *whole* document.
  // `truncation` is filled in immediately below, once we know what was cut.
  const draft: ReviewResult = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    detail: request.detail,
    scopes: request.scopes,
    repository: inspection.repository,
    changes: inspectionFailed ? emptyChangeSet() : inspection.changes,
    validations,
    diagnostics,
    truncation: { applied: false, droppedBytes: 0, fields: [] },
  };

  const budgeted = enforceTotalBudget(draft, request.limits.maxTotalBytes);
  let changes = budgeted.result.changes;
  validations = budgeted.result.validations;

  let truncatedFields = collectTruncatedFields(changes, validations);

  const streamDroppedBytes = upstreamDroppedBytes(validations);
  let truncation: TruncationInfo = {
    applied:
      truncatedFields.length > 0 ||
      streamDroppedBytes > 0 ||
      budgeted.droppedBytes > 0,
    droppedBytes: streamDroppedBytes + budgeted.droppedBytes,
    fields: [...truncatedFields].sort(),
  };

  if (truncation.applied) {
    diagnostics.push({
      code: "W_TRUNCATED",
      severity: "warning",
      message: `Output was truncated to fit configured limits (${truncation.fields.length} field(s) affected).`,
      hint: "Re-run with --detail full, a higher --max-output-bytes, or inspect the failing command directly.",
    });
  }

  // `ok` requires that nothing fatal happened AND that every validation the
  // caller asked for actually ran and passed. A denied validation counts as
  // not-ok: the caller's request was not satisfied, and reporting success
  // would hide that.
  const ok =
    !inspectionFailed && validations.every((v) => v.status === "passed");

  let result: ReviewResult = {
    ...draft,
    ok,
    changes,
    validations,
    diagnostics,
    truncation,
  };

  // Adding W_TRUNCATED and the truncation manifest itself costs bytes. Recheck
  // the completed document so the externally visible JSON, rather than an
  // intermediate draft, is what obeys maxTotalBytes.
  let droppedBytes = streamDroppedBytes + budgeted.droppedBytes;
  for (
    let attempt = 0;
    attempt < 4 && serialisedSize(result) > request.limits.maxTotalBytes;
    attempt += 1
  ) {
    const correction = enforceTotalBudget(result, request.limits.maxTotalBytes);
    droppedBytes += correction.droppedBytes;
    changes = correction.result.changes;
    validations = correction.result.validations;
    truncatedFields = collectTruncatedFields(changes, validations);
    truncation = {
      applied: true,
      droppedBytes,
      fields: [...truncatedFields].sort(),
    };
    result = {
      ...correction.result,
      changes,
      validations,
      truncation,
    };
  }

  return result;
}
