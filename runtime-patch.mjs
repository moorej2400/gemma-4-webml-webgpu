/**
 * Applies the checked-in runtime patch identically in Node and the browser.
 *
 * Hash verification depends on this module remaining the sole patching and
 * trailing-newline implementation for both preparation paths. The parser
 * accepts only the unified-diff subset emitted by this repository's patch.
 */
export function applyUnifiedPatch(source, patchText) {
  if (patchText === "") return source;

  const sourceLines = source.split("\n");
  const patchLines = patchText.split("\n");
  const result = [];
  let sourceIndex = 0;
  let patchIndex = 0;
  let hunkCount = 0;
  let metadataRank = -1;
  const metadataSeen = new Set();

  while (patchIndex < patchLines.length) {
    const line = patchLines[patchIndex];
    const header = parseHunkHeader(line);
    if (!header) {
      if (line.startsWith("@@")) {
        throw new Error(
          `Malformed runtime patch hunk header at patch line ${patchIndex + 1}`,
        );
      }
      if (hunkCount > 0) {
        if (line === "" && patchLines.slice(patchIndex).every((item) => item === "")) {
          break;
        }
        throw new Error(
          `Unsupported runtime patch line at patch line ${patchIndex + 1}: ${line}`,
        );
      }

      const metadata = parseMetadata(line);
      if (!metadata) {
        throw new Error(
          `Unsupported runtime patch metadata at patch line ${patchIndex + 1}: ${line}`,
        );
      }
      if (metadataSeen.has(metadata.kind) || metadata.rank < metadataRank) {
        throw new Error(
          `Malformed runtime patch metadata order at patch line ${patchIndex + 1}`,
        );
      }
      if (metadata.kind === "new" && !metadataSeen.has("old")) {
        throw new Error("Runtime patch new-file metadata requires old-file metadata");
      }
      metadataSeen.add(metadata.kind);
      metadataRank = metadata.rank;
      patchIndex += 1;
      continue;
    }

    if (metadataSeen.has("old") !== metadataSeen.has("new")) {
      throw new Error("Runtime patch file metadata must include both old and new paths");
    }

    const {
      oldStart,
      oldCount,
      newStart,
      newCount,
    } = header;
    const hunkStart = oldCount === 0 ? oldStart : oldStart - 1;
    const outputStart = newCount === 0 ? newStart : newStart - 1;
    if (hunkStart < 0 || hunkStart > sourceLines.length) {
      throw new Error("Runtime patch hunk starts outside the source range");
    }
    if (hunkStart + oldCount > sourceLines.length) {
      throw new Error("Runtime patch hunk exceeds the source range");
    }
    if (hunkStart < sourceIndex) {
      throw new Error("Runtime patch contains overlapping hunks");
    }
    result.push(...sourceLines.slice(sourceIndex, hunkStart));
    if (result.length !== outputStart) {
      throw new Error("Runtime patch hunk new start does not match produced output");
    }

    sourceIndex = hunkStart;
    patchIndex += 1;
    hunkCount += 1;
    let consumed = 0;
    let produced = 0;
    let previousWasOperation = false;

    while (consumed < oldCount || produced < newCount) {
      if (patchIndex >= patchLines.length) break;
      const bodyLine = patchLines[patchIndex];
      if (bodyLine.startsWith("@@")) {
        break;
      }
      if (
        bodyLine === ""
        && patchLines.slice(patchIndex).every((item) => item === "")
      ) {
        break;
      }
      if (bodyLine === "\\ No newline at end of file") {
        if (!previousWasOperation) {
          throw new Error("Runtime patch newline marker must follow a hunk operation");
        }
        previousWasOperation = false;
        patchIndex += 1;
        continue;
      }

      const operation = bodyLine[0];
      const content = bodyLine.slice(1);
      if (operation === " " || operation === "-") {
        if (consumed >= oldCount || sourceIndex >= sourceLines.length) {
          throw new Error("Runtime patch hunk old count mismatch");
        }
        if (sourceLines[sourceIndex] !== content) {
          throw new Error(
            `Runtime patch context mismatch at source line ${sourceIndex + 1}`,
          );
        }
        consumed += 1;
        sourceIndex += 1;
      }
      if (operation === " " || operation === "+") {
        if (produced >= newCount) {
          throw new Error("Runtime patch hunk new count mismatch");
        }
        result.push(content);
        produced += 1;
      }
      if (operation !== " " && operation !== "-" && operation !== "+") {
        throw new Error(
          `Unsupported runtime patch line at patch line ${patchIndex + 1}: ${bodyLine}`,
        );
      }
      previousWasOperation = true;
      patchIndex += 1;
    }

    if (consumed !== oldCount) {
      throw new Error(
        `Runtime patch hunk old count mismatch: expected ${oldCount}, consumed ${consumed}`,
      );
    }
    if (produced !== newCount) {
      throw new Error(
        `Runtime patch hunk new count mismatch: expected ${newCount}, produced ${produced}`,
      );
    }

    if (patchLines[patchIndex] === "\\ No newline at end of file") {
      if (!previousWasOperation) {
        throw new Error("Runtime patch newline marker must follow a hunk operation");
      }
      patchIndex += 1;
    }

    const nextLine = patchLines[patchIndex];
    if (nextLine?.startsWith("-") && !nextLine.startsWith("--- ")) {
      throw new Error("Runtime patch hunk old count mismatch");
    }
    if (nextLine?.startsWith("+") && !nextLine.startsWith("+++ ")) {
      throw new Error("Runtime patch hunk new count mismatch");
    }
    if (nextLine?.startsWith(" ")) {
      throw new Error("Runtime patch hunk old and new count mismatch");
    }
  }

  if (hunkCount === 0) {
    throw new Error("Runtime patch contains no hunks");
  }
  result.push(...sourceLines.slice(sourceIndex));
  return result.join("\n");
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(
    line,
  );
  if (!match) return null;

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function parseMetadata(line) {
  if (/^diff --git a\/\S+ b\/\S+$/u.test(line)) {
    return { kind: "diff", rank: 0 };
  }
  if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/u.test(line)) {
    return { kind: "index", rank: 1 };
  }
  if (/^--- (?:a\/\S+|\/dev\/null)$/u.test(line)) {
    return { kind: "old", rank: 2 };
  }
  if (/^\+\+\+ (?:b\/\S+|\/dev\/null)$/u.test(line)) {
    return { kind: "new", rank: 3 };
  }
  return null;
}

export function normalizeTrailingNewline(source) {
  return `${source.replace(/[\r\n]+$/u, "")}\n`;
}
