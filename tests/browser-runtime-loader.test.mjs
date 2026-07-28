import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import { createBrowserRuntimeLoader } from "../browser-runtime-loader.mjs";
import {
  applyUnifiedPatch,
  normalizeTrailingNewline,
} from "../runtime-patch.mjs";

const root = new URL("../", import.meta.url);
const loaderUrl = new URL("../browser-runtime-loader.mjs", import.meta.url).href;
const expectedImports = [
  "./weight-range-plan.mjs",
  "./disk-backed-embedding.mjs",
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalized(value) {
  return normalizeTrailingNewline(value);
}

function response(body, { status = 200 } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
  };
}

function runtimeSource(extraImport = "") {
  return [
    'import { planTensorSpans } from "./weight-range-plan.mjs";',
    'import { createDiskBackedEmbeddingWriter } from "./disk-backed-embedding.mjs";',
    extraImport,
    "export const runtime = { planTensorSpans, createDiskBackedEmbeddingWriter };",
    "",
  ].filter(Boolean).join("\n");
}

function buildHarness({
  source = runtimeSource(),
  patch = "",
  sourceSha256 = digest(source),
  patched = normalized(source),
  patchedSha256 = digest(patched),
  patchPath = "patches/runtime.patch",
  statuses = {},
  importModule = async () => ({ runtime: true }),
} = {}) {
  const manifest = {
    sourceUrl: "https://runtime.example/gemma-4-e2b.js",
    sourceSha256,
    patch: patchPath,
    patchedSha256,
  };
  const calls = [];
  const blobs = [];
  const revoked = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const key = String(url).endsWith("runtime-manifest.json")
      ? "manifest"
      : String(url).endsWith("runtime.patch")
        ? "patch"
        : "source";
    if (statuses[key]) return response("", { status: statuses[key] });
    if (key === "manifest") return response(JSON.stringify(manifest));
    if (key === "patch") return response(patch);
    return response(source);
  };

  return {
    calls,
    blobs,
    revoked,
    load: createBrowserRuntimeLoader({ loaderUrl }),
    dependencies: {
      fetchImpl,
      cryptoImpl: webcrypto,
      loadFormatter: async () => (value) => value,
      createBlob(parts, options) {
        const blob = { source: parts.join(""), options };
        blobs.push(blob);
        return blob;
      },
      createObjectURL: () => "blob:verified-runtime",
      revokeObjectURL: (url) => revoked.push(url),
      importModule,
    },
  };
}

async function loadBrowserBeautifier() {
  const source = await readFile(new URL("../vendor/beautifier.min.js", import.meta.url), "utf8");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.beautifier.js;
}

test("actual local source formatted in-browser and patched matches the manifest", async () => {
  const [manifest, sourceBytes, patch, formatter] = await Promise.all([
    readFile(new URL("runtime-manifest.json", root), "utf8").then(JSON.parse),
    readFile(new URL("gemma-4-e2b.js", root)),
    readFile(new URL("patches/gemma-ios-memory.patch", root), "utf8"),
    loadBrowserBeautifier(),
  ]);
  let importedSource;
  const harness = buildHarness({
    source: sourceBytes,
    patch,
    sourceSha256: manifest.sourceSha256,
    patchedSha256: manifest.patchedSha256,
    patched: "",
    importModule: async () => ({ Gemma4Mobile: class {} }),
  });
  harness.dependencies.loadFormatter = async () => formatter;
  harness.dependencies.createBlob = (parts, options) => {
    importedSource = parts.join("");
    return { options };
  };

  const runtime = await harness.load(harness.dependencies);
  const locallyPatched = normalized(
    applyUnifiedPatch(
      formatter(sourceBytes.toString("utf8"), { indent_size: 2 }),
      patch,
    ),
  );

  assert.equal(typeof runtime.Gemma4Mobile, "function");
  assert.equal(digest(locallyPatched), manifest.patchedSha256);
  for (const specifier of expectedImports) {
    assert.doesNotMatch(importedSource, new RegExp(`from "${specifier.replaceAll(".", "\\.")}"`));
    assert.match(importedSource, new RegExp(new URL(specifier, loaderUrl).href));
  }
});

test("fails closed when the upstream source hash does not match", async () => {
  const harness = buildHarness({ sourceSha256: "0".repeat(64) });

  await assert.rejects(
    harness.load(harness.dependencies),
    /Upstream runtime hash mismatch: expected 0{64}, got [a-f0-9]{64}/,
  );
  assert.equal(harness.blobs.length, 0);
});

test("fails closed when the patched runtime hash does not match", async () => {
  const harness = buildHarness({ patchedSha256: "f".repeat(64) });

  await assert.rejects(
    harness.load(harness.dependencies),
    /Patched runtime hash mismatch: expected f{64}, got [a-f0-9]{64}/,
  );
  assert.equal(harness.blobs.length, 0);
});

test("rejects a manifest patch path outside the app origin", async () => {
  const harness = buildHarness({
    patchPath: "https://runtime.example/runtime.patch",
  });

  await assert.rejects(
    harness.load(harness.dependencies),
    /Runtime patch must be a same-origin local path/,
  );
});

for (const failure of [
  ["manifest", 503, /Runtime manifest request failed: HTTP 503/],
  ["patch", 404, /Runtime patch request failed: HTTP 404/],
  ["source", 502, /Upstream runtime request failed: HTTP 502/],
]) {
  test(`reports ${failure[0]} HTTP failures`, async () => {
    const harness = buildHarness({ statuses: { [failure[0]]: failure[1] } });

    await assert.rejects(harness.load(harness.dependencies), failure[2]);
  });
}

test("resolves the two patched adapter imports against the loader URL", async () => {
  const harness = buildHarness();

  await harness.load(harness.dependencies);

  assert.equal(harness.blobs.length, 1);
  assert.equal(harness.blobs[0].options.type, "text/javascript");
  for (const specifier of expectedImports) {
    assert.match(harness.blobs[0].source, new RegExp(new URL(specifier, loaderUrl).href));
  }
});

test("rejects a missing expected adapter import", async () => {
  const source = runtimeSource().replace(
    'import { planTensorSpans } from "./weight-range-plan.mjs";\n',
    "",
  );
  const harness = buildHarness({
    source,
    patched: normalized(source),
    patchedSha256: digest(normalized(source)),
  });

  await assert.rejects(
    harness.load(harness.dependencies),
    /Expected runtime import is missing: \.\/weight-range-plan\.mjs/,
  );
});

test("rejects unexpected relative static imports", async () => {
  const source = runtimeSource('import "./unexpected.mjs";');
  const harness = buildHarness({
    source,
    patched: normalized(source),
    patchedSha256: digest(normalized(source)),
  });

  await assert.rejects(
    harness.load(harness.dependencies),
    /Unexpected relative runtime import: \.\/unexpected\.mjs/,
  );
});

test("revokes the Blob URL after successful module evaluation", async () => {
  const harness = buildHarness();

  await harness.load(harness.dependencies);

  assert.deepEqual(harness.revoked, ["blob:verified-runtime"]);
});

test("revokes the Blob URL when module evaluation fails", async () => {
  const harness = buildHarness({
    importModule: async () => {
      throw new Error("evaluation failed");
    },
  });

  await assert.rejects(harness.load(harness.dependencies), /evaluation failed/);
  assert.deepEqual(harness.revoked, ["blob:verified-runtime"]);
});

test("deduplicates in-flight loads and caches only a successful module", async () => {
  const gate = Promise.withResolvers();
  let imports = 0;
  const module = { runtime: true };
  const harness = buildHarness({
    importModule: async () => {
      imports += 1;
      await gate.promise;
      return module;
    },
  });

  const first = harness.load(harness.dependencies);
  const second = harness.load(harness.dependencies);
  gate.resolve();

  assert.strictEqual(await first, module);
  assert.strictEqual(await second, module);
  assert.strictEqual(await harness.load(harness.dependencies), module);
  assert.equal(imports, 1);
});

test("clears a failed load so a later invocation can retry", async () => {
  let imports = 0;
  const module = { runtime: true };
  const harness = buildHarness({
    importModule: async () => {
      imports += 1;
      if (imports === 1) throw new Error("first evaluation failed");
      return module;
    },
  });

  await assert.rejects(harness.load(harness.dependencies), /first evaluation failed/);
  assert.strictEqual(await harness.load(harness.dependencies), module);
  assert.equal(imports, 2);
});
