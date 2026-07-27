/**
 * Stores the oversized per-layer embedding in OPFS and exposes small,
 * fixed-shape GPU row caches that compiled inference programs can reuse.
 */

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function disposeResource(resource) {
  if (typeof resource?.dispose === "function") resource.dispose();
  else if (typeof resource?.destroy === "function") resource.destroy();
}

export async function createDiskBackedEmbeddingWriter({
  directory,
  fileName,
  rows,
  hidden,
  groups,
  bits,
}) {
  assertPositiveInteger(rows, "rows");
  assertPositiveInteger(hidden, "hidden");
  assertPositiveInteger(groups, "groups");
  assertPositiveInteger(bits, "bits");

  const rowBits = hidden * bits;
  if (rowBits % 32 !== 0) {
    throw new RangeError("embedding rows must contain a whole number of uint32 words");
  }

  const storageDirectory = directory
    ?? await globalThis.navigator?.storage?.getDirectory?.();
  if (!storageDirectory) {
    throw new Error("Origin-private file storage is required for iPhone loading");
  }

  const fileHandle = await storageDirectory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  const rowBytes = rowBits / 8;
  const expectedBytes = rows * rowBytes;
  let nextOffset = 0;
  let expectedTotal = null;
  let scale = null;
  let finished = false;

  return {
    async writeQuantized(bytes, { pieceOffset, pieceTotal }) {
      if (finished) throw new Error("embedding writer is already closed");
      if (pieceOffset !== nextOffset) {
        throw new Error(
          `expected piece offset ${nextOffset}, received ${pieceOffset}`,
        );
      }
      if (pieceTotal !== expectedBytes) {
        throw new Error(
          `embedding byte length mismatch: expected ${expectedBytes}, received ${pieceTotal}`,
        );
      }
      expectedTotal ??= pieceTotal;
      // Awaiting the OPFS write avoids a second 32 MiB JS copy while keeping the
      // source view alive until Safari has consumed it.
      await writable.write({
        type: "write",
        position: pieceOffset,
        data: bytes,
      });
      nextOffset += bytes.byteLength;
    },

    setScale(values) {
      if (finished) throw new Error("embedding writer is already closed");
      const source = values instanceof Float32Array
        ? values
        : new Float32Array(values.buffer, values.byteOffset, values.byteLength / 4);
      scale = source.slice();
    },

    async finish() {
      if (finished) throw new Error("embedding writer is already closed");
      if (expectedTotal !== expectedBytes || nextOffset !== expectedBytes) {
        throw new Error(
          `incomplete embedding file: received ${nextOffset} of ${expectedBytes} bytes`,
        );
      }
      if (!scale || scale.length !== rows * groups) {
        throw new Error(
          `embedding scale length mismatch: expected ${rows * groups}, received ${scale?.length ?? 0}`,
        );
      }
      finished = true;
      await writable.close();
      return new DiskBackedEmbeddingStore({
        fileHandle,
        rows,
        hidden,
        groups,
        bits,
        rowBytes,
        scale,
      });
    },

    async abort(reason) {
      if (finished) return;
      finished = true;
      await writable.abort?.(reason);
    },
  };
}

class DiskBackedEmbeddingStore {
  constructor({ fileHandle, rows, hidden, groups, bits, rowBytes, scale }) {
    this.fileHandle = fileHandle;
    this.rows = rows;
    this.hidden = hidden;
    this.groups = groups;
    this.bits = bits;
    this.rowBytes = rowBytes;
    this.scale = scale;
  }

  createSession(runtime, capacity) {
    assertPositiveInteger(capacity, "capacity");
    const {
      fileHandle,
      rows,
      groups,
      rowBytes,
      scale,
    } = this;
    const bitsT = runtime.allocateWeightsBuffer({
      byteLength: capacity * rowBytes,
      dtype: "uint32",
      shape: [capacity, this.hidden * this.bits / 32],
      label: "ple-bits-cache",
    });
    const scaleT = runtime.allocateWeightsBuffer({
      byteLength: capacity * this.groups * 4,
      dtype: "float32",
      shape: [capacity, this.groups],
      label: "ple-scale-cache",
    });
    const idsT = runtime.tensorFromTypedArray(
      "uint32",
      [capacity],
      Uint32Array.from({ length: capacity }, (_, index) => index),
    );
    let disposed = false;

    return {
      bitsT,
      scaleT,
      idsT,
      diskBacked: true,
      bits: this.bits,
      vocab: capacity,

      async prepare(tokenIds) {
        if (disposed) throw new Error("embedding session has been disposed");
        if (tokenIds.length !== capacity) {
          throw new RangeError(
            `embedding session requires ${capacity} token ids, received ${tokenIds.length}`,
          );
        }
        for (const tokenId of tokenIds) {
          if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= rows) {
            throw new RangeError(`token id ${tokenId} is outside the embedding table`);
          }
        }

        // Blob slices keep random reads proportional to the requested rows; the
        // 1.1 GiB backing file is never materialized as an ArrayBuffer.
        const file = await fileHandle.getFile();
        const uniqueRows = new Map();
        await Promise.all([...new Set(tokenIds)].map(async (tokenId) => {
          const begin = tokenId * rowBytes;
          const bytes = new Uint8Array(
            await file.slice(begin, begin + rowBytes).arrayBuffer(),
          );
          if (bytes.byteLength !== rowBytes) {
            throw new Error(`disk-backed embedding row ${tokenId} is truncated`);
          }
          uniqueRows.set(tokenId, bytes);
        }));

        const packed = new Uint8Array(capacity * rowBytes);
        const selectedScale = new Float32Array(capacity * groups);
        for (let index = 0; index < capacity; index += 1) {
          const tokenId = tokenIds[index];
          packed.set(uniqueRows.get(tokenId), index * rowBytes);
          selectedScale.set(
            scale.subarray(
              tokenId * groups,
              (tokenId + 1) * groups,
            ),
            index * groups,
          );
        }

        runtime.writeWeightsRange(bitsT, 0, packed);
        runtime.writeWeightsRange(
          scaleT,
          0,
          new Uint8Array(selectedScale.buffer),
        );
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        disposeResource(idsT);
        disposeResource(bitsT);
        disposeResource(scaleT);
      },
    };
  }
}
