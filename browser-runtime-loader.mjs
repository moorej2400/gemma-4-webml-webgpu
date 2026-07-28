import {
  applyUnifiedPatch,
  normalizeTrailingNewline,
} from "./runtime-patch.mjs";

const EXPECTED_RELATIVE_IMPORTS = [
  "./weight-range-plan.mjs",
  "./disk-backed-embedding.mjs",
];

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

async function resolveRuntimeImports(source, loaderUrl, moduleLexer) {
  const expected = new Map(
    EXPECTED_RELATIVE_IMPORTS.map((specifier) => [specifier, 0]),
  );
  const loader = new URL(loaderUrl);
  // The bundle hash authenticates bytes; the lexer closes its dependency graph
  // before Blob evaluation can trigger any attacker-selected module request.
  const [dependencies] = await moduleLexer.parse(source);
  const rewrites = [];

  for (const dependency of dependencies) {
    const parsedSpecifier = dependency.n
      ?? source.slice(dependency.s, dependency.e);
    const specifier = parsedSpecifier || "<dynamic expression>";
    const statement = source.slice(dependency.ss, dependency.se);
    const isStaticImport = dependency.d === -1
      && dependency.t === moduleLexer.ImportType.Static
      && /^\s*import(?:\s|["'])/u.test(statement);
    if (!isStaticImport || !expected.has(specifier)) {
      throw new Error(`Unexpected runtime dependency: ${specifier}`);
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
    rewrites.push({
      start: dependency.s,
      end: dependency.e,
      value: absolute.href,
    });
  }

  for (const [specifier, count] of expected) {
    if (count !== 1) {
      throw new Error(`Expected runtime import is missing: ${specifier}`);
    }
  }

  let resolved = source;
  for (const rewrite of rewrites.sort((left, right) => right.start - left.start)) {
    resolved = [
      resolved.slice(0, rewrite.start),
      rewrite.value,
      resolved.slice(rewrite.end),
    ].join("");
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

function loadDefaultModuleLexer() {
  return import(new URL("./vendor/es-module-lexer.mjs", import.meta.url));
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
      loadModuleLexer = loadDefaultModuleLexer,
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

      const moduleLexer = await loadModuleLexer();
      const importable = await resolveRuntimeImports(
        patched,
        loaderUrl,
        moduleLexer,
      );
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
