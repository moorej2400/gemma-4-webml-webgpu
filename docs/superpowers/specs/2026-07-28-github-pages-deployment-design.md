# GitHub Pages Deployment Design

**Date:** 2026-07-28

## Goal

Publish the Gemma 4 WebGPU chat at
`https://moorej2400.github.io/gemma-4-webml-webgpu/` so a visitor can open the
page and run the model locally without cloning the repository.

## Constraints

- GitHub Pages may host only files this project has the right to redistribute.
- The upstream `gemma-4-e2b.js` runtime has no declared reuse license.
- The patched iPhone runtime must still be used; the unmodified upstream bundle
  does not contain the memory-safe loader.
- The model remains a multi-gigabyte download and requires WebGPU plus enough
  device memory. Public availability does not imply universal device support.
- LAN Safari debugging must continue to work without attempting to connect
  public visitors to a nonexistent debug WebSocket.

## Runtime Delivery

The repository will not commit or publish the upstream or generated runtime.
Instead, a browser runtime loader will:

1. Fetch `gemma-4-e2b.js` from the upstream Hugging Face Space, which already
   distributes that file and permits cross-origin browser requests.
2. Verify the exact source bytes against `sourceSha256` in
   `runtime-manifest.json`.
3. Format the source in memory with the MIT-licensed browser build of
   `js-beautify`.
4. Apply the repository's audited unified patch in memory.
5. Verify the patched bytes against `patchedSha256`.
6. Import the verified runtime from a temporary Blob URL.
7. Revoke the Blob URL after module evaluation.

The small browser formatter and its license will be included in the public
site. The third-party Gemma runtime will exist only at its upstream host and in
the visitor's browser memory.

The Node preparation script and browser loader will share the same patch
application behavior and manifest. Tests will prove that both paths produce the
same patched SHA-256.

## Application Integration

`ModelLifecycle.importRuntime` will call the browser runtime loader instead of
importing a generated local file. Runtime fetching and transformation remain
deferred until after the origin-wide Web Lock is acquired, preserving the
single-owner memory guarantee.

The previously approved chat-first flow remains the default:

- the first submitted prompt starts loading;
- the prompt stays intact during loading;
- generation begins once after warmup;
- duplicate submission is blocked;
- manual model controls are available only through the persisted Settings
  preference.

## Public And Local Diagnostics

The debug client will activate only on localhost and private LAN hostnames. On a
public Pages hostname it will not open a WebSocket, wrap fetch, or install
remote command handlers.

Normal application errors remain visible in the browser console. The public
site does not collect prompts, generated text, or application telemetry.

## Pages Build

A GitHub Actions workflow triggered by pushes to `main` and manual dispatch
will:

1. Check out the exact commit.
2. Install locked Node dependencies.
3. Run the full test suite.
4. Build an allowlisted `_site` directory containing only runtime application
   files, the patch, manifest, browser formatter, license, and public
   documentation files.
5. Verify that neither `gemma-4-e2b.js` nor `gemma-4-e2b.pretty.js` is present.
6. Upload the Pages artifact.
7. Deploy through the `github-pages` environment using `pages: write` and
   `id-token: write`.

The workflow will use the official `configure-pages`,
`upload-pages-artifact`, and `deploy-pages` actions.

## Repository Settings

GitHub Pages will be enabled with `build_type: workflow`. The public repository
will retain `main` as its default branch. The README will link directly to the
live application and explain that inference happens in the visitor's browser.

## Verification

- Unit tests cover SHA-256 verification, patch rejection, formatter loading,
  Blob URL cleanup, and debug-client public-host inactivity.
- Clean-checkout tests prove generated runtimes are absent.
- The Pages build test inspects the complete artifact allowlist and rejects
  either runtime bundle.
- The deployed URL must return HTTPS 200 and load all first-party modules.
- Chrome verifies the first-message flow and Settings behavior.
- A real iPhone Safari verifies first-message loading, generation, reload,
  and a second load without a tab crash.
