# Technical Overview

## Components

- `index.html` and `app.js` provide the chat interface, model-loading flow, streamed output, and generation statistics.
- `browser-runtime-loader.mjs` verifies, formats, patches, and imports the
  upstream Gemma 4 WebGPU runtime after model ownership is acquired.
- `runtime-patch.mjs` applies the same checked-in patch in browsers and the
  optional Node preparation script.
- `disk-backed-embedding.mjs` keeps the oversized per-layer embedding out of
  resident GPU memory on iPhone.
- `server.js` provides a dependency-free HTTP/HTTPS development server and WebSocket debugging channel.
- `debug-client.js` forwards browser errors, network diagnostics, and WebGPU capability information to the development server.

## Model Loading

The browser verifies the exact upstream runtime bytes and exact patched output
before importing a temporary Blob module. Runtime preparation starts only
after the page owns the model Web Lock. The runtime then downloads model
weights, tokenizer data, and configuration from
`google/gemma-4-E2B-it-qat-mobile-transformers` on Hugging Face. Large
responses may be cached by the browser. No model weights are stored in this
repository.

On iPhone, the loader uses one 32 MiB download lane. The model contains a
1.1 GiB per-layer embedding that exceeds Safari's practical resident-memory
budget when loaded alongside the rest of the model. The patched runtime streams
that table into origin-private file storage instead of allocating it on the
GPU.

At inference time, only the rows for the current prompt or generated token are
read from disk and uploaded into a small fixed GPU cache. This keeps inference
local while avoiding a full-table GPU allocation. The remaining model weights
stay resident on the GPU for fast generation.

Only one page per origin may own the model. The app holds an exclusive Web Lock
for the model's complete lifetime and releases it only after asynchronous GPU
cleanup finishes.

## Local HTTPS

WebGPU requires a secure browser context on LAN devices. On startup, the server creates a private development certificate authority and a server certificate containing the Mac's current LAN addresses. Generated files live under `certs/` and are intentionally excluded from Git.

The HTTP listener serves `localhost` directly. Requests made through a LAN address are redirected to HTTPS. The server exposes only the public CA certificate and trust profile; requests for private keys return `404`.

Default ports:

- HTTP and certificate bootstrap: `8080`
- HTTPS application and secure debugging: `8443`

Override them with `PORT` and `HTTPS_PORT`.

## Device Debugging

The browser client opens a WebSocket connection to `/__debug`. It reports console messages, uncaught errors, failed network requests, browser capabilities, and selected WebGPU adapter details. The server prints these events and appends them to `debug.log`.

Development-only command endpoints can reload connected pages, list clients,
load or dispose the model, and run a prompt. Commands are allowlisted and do
not accept executable JavaScript. Keep the server on a trusted local network
and do not expose it to the public internet.

## Verification

Run the TLS integration check on macOS:

```sh
bash tests/verify-ios-tls.sh
npm test
```

The test uses temporary ports, verifies the generated certificate chain and key permissions, checks that private keys are not publicly served, and confirms LAN traffic redirects to HTTPS.
