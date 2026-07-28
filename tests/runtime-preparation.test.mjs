import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("prepares a hash-verified importable runtime from the upstream artifact", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "gemma-runtime-"));
  const output = path.join(temp, "gemma-4-e2b.pretty.js");
  await cp(path.join(root, "weight-range-plan.mjs"), path.join(temp, "weight-range-plan.mjs"));
  await cp(
    path.join(root, "disk-backed-embedding.mjs"),
    path.join(temp, "disk-backed-embedding.mjs"),
  );

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/prepare-runtime.mjs"),
    "--source", path.join(root, "gemma-4-e2b.js"),
    "--output", output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(await readFile(path.join(root, "runtime-manifest.json"), "utf8"));
  assert.equal(
    manifest.sourceUrl,
    "https://webml-community-gemma-4-webgpu-kernels.static.hf.space/gemma-4-e2b.js",
  );
  const bytes = await readFile(output);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.patchedSha256);

  const runtime = await import(pathToFileURL(output));
  assert.equal(typeof runtime.Gemma4Mobile.load, "function");
  assert.equal(typeof runtime.withOwnedRuntime, "function");
});
