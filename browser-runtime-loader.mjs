import {
  applyUnifiedPatch,
  normalizeTrailingNewline,
} from "./runtime-patch.mjs";

const EXPECTED_RELATIVE_IMPORTS = [
  "./weight-range-plan.mjs",
  "./disk-backed-embedding.mjs",
];
const STATIC_IMPORT_PATTERN =
  /(^|\n)([ \t]*import[ \t]+(?:[\s\S]*?[ \t]+from[ \t]+)?)(["'])([^"']+)\3/g;

async function requireOk(response, label) {
  if (!response.ok) {
    throw new Error(`${label} request failed: HTTP ${response.status}`);
  }
  return response;
}

async function sha256Hex(value, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("");
}

function resolveRuntimeImports(source, loaderUrl) {
  const expected = new Map(
    EXPECTED_RELATIVE_IMPORTS.map((specifier) => [specifier, 0]),
  );
  const loader = new URL(loaderUrl);

  const resolved = source.replace(
    STATIC_IMPORT_PATTERN,
    (statement, start, prefix, quote, specifier) => {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return statement;
      }
      if (!expected.has(specifier)) {
        throw new Error(`Unexpected relative runtime import: ${specifier}`);
      }

      const count = expected.get(specifier) + 1;
      expected.set(specifier, count);
      if (count > 1) {
        throw new Error(`Runtime import appears more than once: ${specifier}`);
      }

      const absolute = new URL(specifier, loader);
      if (absolute.origin !== loader.origin) {
        throw new Error(`Runtime import is not same-origin: ${specifier}`);
      }
      return `${start}${prefix}${quote}${absolute.href}${quote}`;
    },
  );

  for (const [specifier, count] of expected) {
    if (count !== 1) {
      throw new Error(`Expected runtime import is missing: ${specifier}`);
    }
  }
  return resolved;
}

async function loadDefaultFormatter() {
  if (globalThis.beautifier?.js) return globalThis.beautifier.js;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/beautifier.min.js", import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error("Browser runtime formatter failed to load"));
    };
    document.head.append(script);
  });

  if (typeof globalThis.beautifier?.js !== "function") {
    throw new Error("Browser runtime formatter did not expose beautifier.js");
  }
  return globalThis.beautifier.js;
}

/**
 * Creates one document-scoped verified runtime cache.
 *
 * Every expensive operation stays inside the returned function so importing
 * this module at app boot cannot fetch, format, allocate a Blob, or import the
 * WebGPU runtime before ModelLifecycle owns the Web Lock.
 */
export function createBrowserRuntimeLoader({ loaderUrl = import.meta.url } = {}) {
  let cachedLoad = null;

  return function loadRuntime(dependencies = {}) {
    if (cachedLoad) return cachedLoad;

    const {
      fetchImpl = globalThis.fetch.bind(globalThis),
      cryptoImpl = globalThis.crypto,
      loadFormatter = loadDefaultFormatter,
      createBlob = (parts, options) => new Blob(parts, options),
      createObjectURL = (blob) => URL.createObjectURL(blob),
      revokeObjectURL = (url) => URL.revokeObjectURL(url),
      importModule = (url) => import(url),
    } = dependencies;

    cachedLoad = (async () => {
      const manifestUrl = new URL("./runtime-manifest.json", loaderUrl);
      const manifestResponse = await requireOk(
        await fetchImpl(manifestUrl),
        "Runtime manifest",
      );
      const manifest = await manifestResponse.json();
      const patchUrl = new URL(manifest.patch, loaderUrl);
      if (patchUrl.origin !== new URL(loaderUrl).origin) {
        throw new Error("Runtime patch must be a same-origin local path");
      }

      const [patchResponse, sourceResponse] = await Promise.all([
        fetchImpl(patchUrl).then((response) => requireOk(response, "Runtime patch")),
        fetchImpl(manifest.sourceUrl).then((response) => (
          requireOk(response, "Upstream runtime")
        )),
      ]);
      const [patchText, sourceBuffer] = await Promise.all([
        patchResponse.text(),
        sourceResponse.arrayBuffer(),
      ]);

      const sourceDigest = await sha256Hex(sourceBuffer, cryptoImpl);
      if (sourceDigest !== manifest.sourceSha256) {
        throw new Error(
          `Upstream runtime hash mismatch: expected ${manifest.sourceSha256}, got ${sourceDigest}`,
        );
      }

      const formatter = await loadFormatter();
      const formatted = formatter(
        new TextDecoder().decode(sourceBuffer),
        { indent_size: 2 },
      );
      const patched = normalizeTrailingNewline(
        applyUnifiedPatch(formatted, patchText),
      );
      const patchedBytes = new TextEncoder().encode(patched);
      const patchedDigest = await sha256Hex(patchedBytes, cryptoImpl);
      if (patchedDigest !== manifest.patchedSha256) {
        throw new Error(
          `Patched runtime hash mismatch: expected ${manifest.patchedSha256}, got ${patchedDigest}`,
        );
      }

      const importable = resolveRuntimeImports(patched, loaderUrl);
      const blob = createBlob([importable], { type: "text/javascript" });
      const blobUrl = createObjectURL(blob);
      try {
        return await importModule(blobUrl);
      } finally {
        revokeObjectURL(blobUrl);
      }
    })();

    cachedLoad.catch(() => {
      cachedLoad = null;
    });
    return cachedLoad;
  };
}

export const loadBrowserRuntime = createBrowserRuntimeLoader();
