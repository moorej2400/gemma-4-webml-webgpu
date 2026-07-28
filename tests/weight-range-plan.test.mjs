import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  coalesceTensorSpans,
  largestUnsplitSpan,
  planTensorSpans,
  runWithConcurrency,
} from "../weight-range-plan.mjs";

const MIB = 1024 * 1024;
const fixtureUrl = new URL("./fixtures/model-safetensors-header.json", import.meta.url);
const expectedHeaderSha256 = "8fd4ebc21f5e9c579d9498bb6712167249cb6480c750a7738690c20ecb0e8c34";

async function currentTensorMap() {
  const bytes = await readFile(fixtureUrl);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHeaderSha256);
  const header = JSON.parse(bytes);
  return new Map(
    Object.entries(header)
      .filter(([name]) => name !== "__metadata__")
      .map(([name, tensor]) => [name, { dataOffsets: tensor.data_offsets }]),
  );
}

test("uses hash-bound metadata from the current authoritative model", async () => {
  const tensors = await currentTensorMap();

  assert.equal(tensors.size, 2780);
  assert.deepEqual(
    tensors.get("model.language_model.embed_tokens_per_layer.embedding_quantized").dataOffsets,
    [639243518, 1813648638],
  );
  assert.equal(
    tensors.get("lm_head.weight").dataOffsets[1] - tensors.get("lm_head.weight").dataOffsets[0],
    96 * MIB,
  );
});

test("splits only the 1120 MiB streamed embedding into 32 MiB pieces", async () => {
  const tensors = await currentTensorMap();
  const spans = planTensorSpans(tensors, null, 32 * MIB);
  const embedding = spans.filter(
    (span) => span.name === "model.language_model.embed_tokens_per_layer.embedding_quantized",
  );
  const lmHead = spans.filter((span) => span.name === "lm_head.weight");

  assert.equal(embedding.length, 35);
  assert.equal(Math.max(...embedding.map((span) => span.end - span.begin)), 32 * MIB);
  assert.ok(embedding.every((span) => span.pieceTotal === 1120 * MIB));
  assert.equal(lmHead.length, 1);
  assert.equal(lmHead[0].end - lmHead[0].begin, 96 * MIB);
  assert.deepEqual(largestUnsplitSpan(spans), {
    name: "lm_head.weight",
    byteLength: 96 * MIB,
  });
});

test("coalescing respects the cap except for one intentionally unsplit tensor", async () => {
  const spans = planTensorSpans(await currentTensorMap(), null, 32 * MIB);
  const chunks = coalesceTensorSpans(spans, { maxBytes: 32 * MIB, maxGap: 64 * 1024 });

  for (const chunk of chunks) {
    const byteLength = chunk.end - chunk.begin;
    assert.ok(
      byteLength <= 32 * MIB || (chunk.tensors.length === 1 && chunk.tensors[0].pieceTotal == null),
      `unexpected ${byteLength}-byte coalesced chunk`,
    );
  }
});

test("iOS worker profile allows only one active range", async () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  let active = 0;
  let maximumActive = 0;

  await runWithConcurrency(items, 1, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });

  assert.equal(maximumActive, 1);
});

test("range workers recover from transient browser network errors", async () => {
  let attempts = 0;

  await runWithConcurrency(["weights"], 1, async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("network error");
  });

  assert.equal(attempts, 3);
});

test("range workers do not retry non-network failures", async () => {
  let attempts = 0;
  const failure = new Error("GPU buffer allocation failed");

  await assert.rejects(
    runWithConcurrency(["weights"], 1, async () => {
      attempts += 1;
      throw failure;
    }),
    failure,
  );

  assert.equal(attempts, 1);
});
