# Runtime Preparation

The WebGPU runtime used by this project comes from the WebML Community's Gemma
4 WebGPU Kernels Space. That upstream repository does not currently provide a
license grant for redistributing its bundle, so the bundle is not committed
here.

## Prepare The Runtime

From the project directory:

```sh
npm install
npm run prepare-runtime
```

The preparation command:

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

Both the source and generated runtime are ignored by Git. Do not commit either
file unless the upstream licensing situation changes and redistribution has
been reviewed.
