import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeUrl = new URL("../gemma-4-e2b.pretty.js", import.meta.url);

test("runtime selects disk-backed PLE loading and forwards the iOS option", async () => {
  const source = await readFile(runtimeUrl, "utf8");

  assert.match(source, /__createDiskBackedEmbeddingWriter/);
  assert.match(source, /\(t\.diskBackedPle \? oD : oT\)/);
  assert.equal(
    [...source.matchAll(/diskBackedPle:\s*[ar]\.diskBackedPle/g)].length,
    2,
  );
});

test("every inference path prepares compact PLE rows before GPU submission", async () => {
  const source = await readFile(runtimeUrl, "utf8");

  assert.match(source, /pleSession\.prepare\(n\)/);
  assert.match(source, /await this\.ple\.prepare\(new Uint32Array\(\[n \?\? 0\]\)\)/);
  assert.match(source, /i\.set\(n\), await this\.ple\.prepare\(i\)/);
  assert.match(source, /vo > 1 && !this\.weights\.embedTokensPerLayer\.diskBacked/);
});
