/**
 * Text normalisation and deterministic truncation.
 *
 * Every byte this tool emits may land in an LLM context window, so all
 * shrinking happens here and is always self-declaring: a caller can tell from
 * the returned metadata exactly how much was dropped.
 */

/**
 * Matches ANSI escape sequences: OSC (terminated by BEL or ST) and CSI/other
 * two-byte sequences. Built with explicit \u escapes so the source stays plain
 * ASCII rather than embedding raw control characters.
 */
const ANSI_PATTERN = new RegExp(
  [
    // OSC: ESC ] ... (BEL | ST)
    "[\\u001B\\u009B]\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    // CSI: ESC [ parameters intermediates final
    "[\\u001B\\u009B]\\[[0-?]*[ -/]*[@-~]",
    // Other two-character escape sequences
    "\\u001B[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Collapses CRLF to LF and resolves carriage-return overwrites.
 *
 * Progress bars ("[###   ] 30%\r[####  ] 40%\r...") emit megabytes that render
 * as a single line in a terminal. Keeping only the text after the last CR on
 * each line reproduces what a human would have seen, and routinely turns
 * multi-megabyte output into a few hundred bytes.
 */
export function normalizeNewlines(input: string): string {
  const unified = input.replace(/\r\n/g, "\n");
  if (!unified.includes("\r")) return unified;
  return unified
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr === -1 ? line : line.slice(lastCr + 1);
    })
    .join("\n");
}

/**
 * Full normalisation applied to any captured subprocess output before it is
 * stored in a result: strip ANSI, resolve CRs, drop NUL bytes.
 *
 * NUL is removed because it is not representable in JSON strings in a way all
 * consumers survive, and because it can be used to truncate output in naive
 * downstream C-string handling.
 */
export function sanitizeOutput(input: string): string {
  return normalizeNewlines(stripAnsi(input)).replace(/\u0000/g, "");
}

export type ClampOptions = {
  /** Maximum size in UTF-8 bytes. */
  maxBytes: number;
  /** Maximum number of lines. */
  maxLines: number;
  /**
   * Fraction of the budget kept from the start. The default keeps 30% head /
   * 70% tail because a command's invocation appears at the start but its
   * failure almost always appears at the end.
   */
  headRatio?: number;
};

export type ClampResult = {
  text: string;
  truncated: boolean;
  /** UTF-8 bytes removed from the original. */
  droppedBytes: number;
  /** Lines removed from the original. */
  droppedLines: number;
};

/** Slices the first `n` bytes without splitting a UTF-8 code point. */
function sliceHeadBytes(buf: Buffer, n: number): Buffer {
  if (n >= buf.length) return buf;
  let end = Math.max(0, n);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** Slices the last `n` bytes without splitting a UTF-8 code point. */
function sliceTailBytes(buf: Buffer, n: number): Buffer {
  if (n >= buf.length) return buf;
  let start = buf.length - Math.max(0, n);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/**
 * Truncates text to fit both a line budget and a byte budget, keeping the head
 * and the tail and replacing the middle with an explicit marker.
 *
 * Deterministic: the same input and options always produce the same output,
 * which is what makes the CLI/MCP consistency test possible.
 */
export function clampText(input: string, options: ClampOptions): ClampResult {
  const { maxBytes, maxLines } = options;
  const headRatio = options.headRatio ?? 0.3;

  const originalBytes = Buffer.byteLength(input, "utf8");
  const originalLines = input.length === 0 ? 0 : input.split("\n").length;

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { text: input, truncated: false, droppedBytes: 0, droppedLines: 0 };
  }

  let working = input;
  let droppedLines = 0;

  // Line budget first: it is the cheaper and more legible reduction.
  if (originalLines > maxLines && maxLines > 0) {
    const lines = working.split("\n");
    const headCount = Math.max(1, Math.floor(maxLines * headRatio));
    const tailCount = Math.max(1, maxLines - headCount);
    droppedLines = lines.length - headCount - tailCount;
    if (droppedLines > 0) {
      working = [
        ...lines.slice(0, headCount),
        `… ${droppedLines} line${droppedLines === 1 ? "" : "s"} elided …`,
        ...lines.slice(lines.length - tailCount),
      ].join("\n");
    } else {
      droppedLines = 0;
    }
  }

  // Byte budget second, on whatever survived.
  // Annotated because `subarray` widens the backing-store type parameter.
  let buf: Buffer<ArrayBufferLike> = Buffer.from(working, "utf8");
  if (buf.length > maxBytes) {
    const marker = (n: number) => `\n… ${n} bytes elided …\n`;
    // Reserve room for the widest plausible marker so the result does not
    // overshoot the budget once the marker is inserted.
    const reserve = Buffer.byteLength(marker(originalBytes), "utf8");
    const usable = Math.max(0, maxBytes - reserve);
    const headBytes = Math.floor(usable * headRatio);
    const tailBytes = usable - headBytes;
    const head = sliceHeadBytes(buf, headBytes);
    const tail = sliceTailBytes(buf, tailBytes);
    const elided = buf.length - head.length - tail.length;
    working =
      head.toString("utf8") + marker(Math.max(0, elided)) + tail.toString("utf8");
    buf = Buffer.from(working, "utf8");

    // Hard guarantee. For a budget smaller than the marker itself the
    // reservation above cannot help, and returning a marker that exceeds the
    // caller's budget would silently break the whole-result accounting that
    // depends on this function. Callers may legitimately pass a very small
    // budget (`--max-output-bytes 1`, or a fair share when many streams
    // compete), so the postcondition must hold unconditionally:
    //
    //     Buffer.byteLength(clampText(s, { maxBytes: n }).text) <= n
    if (buf.length > maxBytes) {
      buf = sliceHeadBytes(buf, maxBytes);
      working = buf.toString("utf8");
    }
  }

  return {
    text: working,
    truncated: true,
    droppedBytes: Math.max(0, originalBytes - Buffer.byteLength(working, "utf8")),
    droppedLines,
  };
}

/**
 * Returns a Markdown code fence wide enough to contain `content` verbatim.
 *
 * CommonMark closes a fenced block at the first fence of equal-or-greater
 * width, so a fence must be wider than the longest backtick run inside.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  let run = 0;
  for (const char of content) {
    if (char === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Byte-wise comparator for repository paths.
 *
 * `String.prototype.localeCompare` is locale-dependent and would make the
 * cross-interface consistency test flaky across machines; comparing UTF-8
 * bytes is stable everywhere.
 */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
