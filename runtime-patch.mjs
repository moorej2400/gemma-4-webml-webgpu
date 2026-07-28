/**
 * Applies the checked-in runtime patch identically in Node and the browser.
 *
 * Hash verification depends on this module remaining the sole patching and
 * trailing-newline implementation for both preparation paths.
 */
export function applyUnifiedPatch(source, patchText) {
  const sourceLines = source.split("\n");
  const patchLines = patchText.split("\n");
  const result = [];
  let sourceIndex = 0;
  let patchIndex = 0;

  while (patchIndex < patchLines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(
      patchLines[patchIndex],
    );
    if (!header) {
      patchIndex += 1;
      continue;
    }

    const hunkStart = Number(header[1]) - 1;
    if (hunkStart < sourceIndex) {
      throw new Error("Runtime patch contains overlapping hunks");
    }
    result.push(...sourceLines.slice(sourceIndex, hunkStart));
    sourceIndex = hunkStart;
    patchIndex += 1;

    while (
      patchIndex < patchLines.length
      && !patchLines[patchIndex].startsWith("@@ ")
    ) {
      const line = patchLines[patchIndex];
      if (
        line.startsWith("diff ")
        || line.startsWith("index ")
        || line.startsWith("--- ")
        || line.startsWith("+++ ")
      ) {
        break;
      }
      if (line === "\\ No newline at end of file") {
        patchIndex += 1;
        continue;
      }

      const operation = line[0];
      const content = line.slice(1);
      if (operation === " " || operation === "-") {
        if (sourceLines[sourceIndex] !== content) {
          throw new Error(
            `Runtime patch context mismatch at source line ${sourceIndex + 1}`,
          );
        }
        if (operation === " ") result.push(content);
        sourceIndex += 1;
      } else if (operation === "+") {
        result.push(content);
      } else if (line !== "") {
        throw new Error(`Unsupported runtime patch line: ${line}`);
      }
      patchIndex += 1;
    }
  }

  result.push(...sourceLines.slice(sourceIndex));
  return result.join("\n");
}

export function normalizeTrailingNewline(source) {
  return `${source.replace(/[\r\n]+$/u, "")}\n`;
}
