# Runtime Preparation

The WebGPU runtime used by this project comes from the WebML Community's Gemma
4 WebGPU Kernels Space. That upstream repository does not currently provide a
license grant for redistributing its bundle, so the bundle is not committed
here.

## Browser Loading

After the app owns its exclusive Web Lock, `browser-runtime-loader.mjs`:

1. Fetches the local manifest and patch.
2. Downloads the exact upstream runtime from the manifest URL.
3. Verifies the upstream SHA-256 before formatting.
4. Loads the vendored browser formatter and applies the shared patch logic.
5. Verifies the patched SHA-256.
6. Resolves the two local adapter imports and evaluates a temporary Blob
   module.

The Blob URL is always revoked. Failed loads are not cached, so a later model
load can retry. Neither the upstream nor patched runtime is stored in Git.

## Prepare The Runtime In Node

The Node command remains available for auditing, tests, and offline
development. From the project directory:

From the project directory:

```sh
npm install
npm run prepare-runtime
```

The preparation command uses the same patch implementation as the browser and:

1. Downloads the runtime from the URL recorded in `runtime-manifest.json`.
2. Refuses to continue unless its SHA-256 matches the audited upstream file.
3. Formats it deterministically.
4. Applies `patches/gemma-ios-memory.patch`.
5. Refuses to write an unexpected patched result.
6. Creates the ignored local file `gemma-4-e2b.pretty.js`.

For offline development, use a previously downloaded matching source:

```sh
npm run prepare-runtime -- --source /path/to/gemma-4-e2b.js
```

Both the source and generated runtime are ignored by Git. They are not required
for normal browser loading. Do not commit either file unless the upstream
licensing situation changes and redistribution has been reviewed.
