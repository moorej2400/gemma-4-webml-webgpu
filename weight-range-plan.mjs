const DEFAULT_SPLIT_THRESHOLD = 192 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 128 * 1024 * 1024;

/**
 * Plans safetensors byte spans without changing tensor order or layout.
 *
 * Only tensors above the established 192 MiB threshold are piecewise. Smaller
 * tensors stay whole because their weight handlers transform them as a unit.
 */
export function planTensorSpans(
  tensors,
  names = null,
  chunkMaxBytes = DEFAULT_CHUNK_BYTES,
  splitThreshold = DEFAULT_SPLIT_THRESHOLD,
) {
  const selected = names == null ? null : new Set(names);
  if (selected?.size === 0) return [];

  if (selected) {
    for (const name of selected) {
      if (!tensors.has(name)) throw new Error(`Unknown tensor: ${name}`);
    }
  }

  const pieceBytes = Math.max(
    4,
    Math.min(chunkMaxBytes ?? DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES) & ~3,
  );
  const spans = [];

  for (const [name, tensor] of tensors) {
    if (selected && !selected.has(name)) continue;
    const [begin, end] = tensor.dataOffsets;
    const byteLength = end - begin;
    if (byteLength <= 0) continue;

    if (byteLength > splitThreshold) {
      for (let pieceOffset = 0; pieceOffset < byteLength; pieceOffset += pieceBytes) {
        spans.push({
          name,
          begin: begin + pieceOffset,
          end: begin + Math.min(pieceOffset + pieceBytes, byteLength),
          pieceOffset,
          pieceTotal: byteLength,
        });
      }
    } else {
      spans.push({ name, begin, end });
    }
  }

  return spans.sort((left, right) => left.begin - right.begin);
}

export function coalesceTensorSpans(spans, { maxBytes, maxGap }) {
  const chunks = [];
  let current = null;

  for (const span of spans) {
    if (!current) {
      current = { begin: span.begin, end: span.end, tensors: [span] };
      continue;
    }

    const gap = span.begin - current.end;
    const combinedBytes = span.end - current.begin;
    if (gap <= maxGap && combinedBytes <= maxBytes) {
      current.end = span.end;
      current.tensors.push(span);
    } else {
      chunks.push(current);
      current = { begin: span.begin, end: span.end, tensors: [span] };
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function largestUnsplitSpan(spans) {
  let largest = null;
  for (const span of spans) {
    if (span.pieceTotal != null) continue;
    const byteLength = span.end - span.begin;
    if (!largest || byteLength > largest.byteLength) {
      largest = { name: span.name, byteLength };
    }
  }
  return largest;
}

export async function runWithConcurrency(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  let nextIndex = 0;
  const runNext = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runNext),
  );
}
