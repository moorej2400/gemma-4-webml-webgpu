# Technical Overview

## Components

- `index.html` and `app.js` provide the chat interface, model-loading flow, streamed output, and generation statistics.
- `gemma-4-e2b.js` provides the upstream Gemma 4 WebGPU runtime and custom kernels.
- `server.js` provides a dependency-free HTTP/HTTPS development server and WebSocket debugging channel.
- `debug-client.js` forwards browser errors, network diagnostics, and WebGPU capability information to the development server.

## Model Loading

The runtime downloads model weights, tokenizer data, and configuration from `google/gemma-4-E2B-it-qat-mobile-transformers` on Hugging Face. Large responses may be cached by the browser. No model weights are stored in this repository.

## Local HTTPS

WebGPU requires a secure browser context on LAN devices. On startup, the server creates a private development certificate authority and a server certificate containing the Mac's current LAN addresses. Generated files live under `certs/` and are intentionally excluded from Git.

The HTTP listener serves `localhost` directly. Requests made through a LAN address are redirected to HTTPS. The server exposes only the public CA certificate and trust profile; requests for private keys return `404`.

Default ports:

- HTTP and certificate bootstrap: `8080`
- HTTPS application and secure debugging: `8443`

Override them with `PORT` and `HTTPS_PORT`.

## Device Debugging

The browser client opens a WebSocket connection to `/__debug`. It reports console messages, uncaught errors, failed network requests, browser capabilities, and selected WebGPU adapter details. The server prints these events and appends them to `debug.log`.

Development-only command endpoints can reload connected pages, evaluate diagnostic JavaScript, and list clients. Keep the server on a trusted local network and do not expose it to the public internet.

## Verification

Run the TLS integration check on macOS:

```sh
bash tests/verify-ios-tls.sh
```

The test uses temporary ports, verifies the generated certificate chain and key permissions, checks that private keys are not publicly served, and confirms LAN traffic redirects to HTTPS.
