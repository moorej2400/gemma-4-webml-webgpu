import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiskBackedEmbeddingWriter,
} from "../disk-backed-embedding.mjs";

function createFakeDirectory() {
  let bytes = new Uint8Array();
  const handle = {
    async createWritable() {
      return {
        async write({ position, data }) {
          const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const nextLength = Math.max(bytes.byteLength, position + source.byteLength);
          if (nextLength !== bytes.byteLength) {
            const next = new Uint8Array(nextLength);
            next.set(bytes);
            bytes = next;
          }
          bytes.set(source, position);
        },
        async close() {},
        async abort() {},
      };
    },
    async getFile() {
      return new Blob([bytes]);
    },
  };
  return {
    async getFileHandle() {
      return handle;
    },
  };
}

function createFakeRuntime() {
  const writes = [];
  return {
    writes,
    allocateWeightsBuffer({ byteLength, dtype, shape, label }) {
      return { byteLength, dtype, shape, label, buffer: { label }, dispose() {} };
    },
    tensorFromTypedArray(dtype, shape, values) {
      return { dtype, shape, values: values.slice(), dispose() {} };
    },
    writeWeightsRange(target, offset, values) {
      writes.push({
        target: target.label,
        offset,
        values: new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice(),
      });
    },
  };
}

test("keeps the full embedding disk-backed and uploads only requested rows", async () => {
  const directory = createFakeDirectory();
  const writer = await createDiskBackedEmbeddingWriter({
    directory,
    fileName: "ple.bin",
    rows: 4,
    hidden: 8,
    groups: 2,
    bits: 4,
  });

  await writer.writeQuantized(Uint8Array.from([0, 1, 2, 3, 10, 11, 12, 13]), {
    pieceOffset: 0,
    pieceTotal: 16,
  });
  await writer.writeQuantized(Uint8Array.from([20, 21, 22, 23, 30, 31, 32, 33]), {
    pieceOffset: 8,
    pieceTotal: 16,
  });
  writer.setScale(new Float32Array([
    0, 1,
    10, 11,
    20, 21,
    30, 31,
  ]));

  const store = await writer.finish();
  const runtime = createFakeRuntime();
  assert.equal(runtime.writes.length, 0);

  const session = store.createSession(runtime, 2);
  await session.prepare(Uint32Array.from([2, 0]));

  assert.deepEqual(
    [...runtime.writes.find((write) => write.target === "ple-bits-cache").values],
    [20, 21, 22, 23, 0, 1, 2, 3],
  );
  const scaleBytes = runtime.writes.find((write) => write.target === "ple-scale-cache").values;
  assert.deepEqual(
    [...new Float32Array(scaleBytes.buffer, scaleBytes.byteOffset, scaleBytes.byteLength / 4)],
    [20, 21, 0, 1],
  );
  assert.deepEqual([...session.idsT.values], [0, 1]);
  assert.equal(session.vocab, 2);
});

test("rejects non-contiguous pieces instead of creating a corrupt disk file", async () => {
  const writer = await createDiskBackedEmbeddingWriter({
    directory: createFakeDirectory(),
    fileName: "ple.bin",
    rows: 4,
    hidden: 8,
    groups: 2,
    bits: 4,
  });

  await assert.rejects(
    writer.writeQuantized(Uint8Array.of(1, 2, 3, 4), {
      pieceOffset: 4,
      pieceTotal: 16,
    }),
    /expected piece offset 0/,
  );
});
