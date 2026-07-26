# iOS Memory-Safe Model Loader Design

**Date:** 2026-07-26

## Goal

Load Gemma 4 reliably in one iPhone Safari tab without changing the WebGPU inference kernels or reducing token-generation speed.

## Evidence And Root Cause

The LAN server, HTTPS certificate, secure context, WebGPU adapter, and model requests all worked. A single iPhone tab previously completed model loading in 65 to 80 seconds.

The failing run had two live Safari clients. The first had downloaded and uploaded most of the 2.34 GB model when the second page automatically called `Gemma4Mobile.load()`. Both pages then disconnected without a JavaScript exception while the Node server remained healthy. This is consistent with iOS terminating the Safari processes under combined CPU and GPU memory pressure.

Three avoidable peak-memory sources remain:

1. Every page automatically starts loading, so multiple tabs or a crash reload can allocate two model copies.
2. iOS currently downloads two weight ranges of up to 64 MB concurrently.
3. The debug client reconstructs each fetch response through a second `ReadableStream`, adding buffering and changing backpressure during the largest downloads.

The public repository also omits `gemma-4-e2b.pretty.js`, even though `app.js` imports that patched runtime.

## Requirements

- At most one page per browser origin may load or own the model.
- A second page must remain lightweight and explain that another tab owns the model.
- Model loading must begin only after an explicit user action or a deliberate remote-debug command.
- iOS must keep transient weight buffers bounded to one 32 MB staging lane.
- Weight responses must flow directly from `fetch` to the runtime loader.
- Load failure must dispose partial GPU state and release ownership when the page survives.
- Page termination must release ownership automatically.
- Desktop loading may retain its current parallel settings.
- Generation code, model tensors, WebGPU kernels, and KV-cache behavior must remain unchanged.
- The public repository must contain every runtime file required by `app.js`.

## Architecture

### 1. Model Session Owner

A small `model-session.js` module owns the browser-wide model lease.

It uses the Web Locks API with an exclusive lock named `gemma-4-webgpu-model`. The lock request uses `ifAvailable: true`, so a second page is rejected immediately instead of waiting while consuming resources. The owning page holds the lock with an unresolved promise for the model lifetime and releases it during explicit disposal or normal page teardown. Browser process termination releases Web Locks automatically.

When Web Locks is unavailable, a conservative fallback uses a `BroadcastChannel` claim handshake. A page broadcasts a claim, waits briefly for an existing owner response, and loads only when no owner responds. The owner emits a heartbeat and relinquishes ownership on `pagehide`. This fallback prefers a false rejection over allowing two model loads.

The model session state is one of:

- `idle`
- `acquiring`
- `owned`
- `blocked`
- `releasing`

Only `owned` may call the model loader.

### 2. Explicit Load Flow

The debug-only automatic `setTimeout(loadModel, 400)` path is removed.

Selecting **Load model** performs this sequence:

1. Acquire model ownership.
2. If unavailable, show `Model active in another tab` and do not create a GPU adapter or fetch model files.
3. Create an `AbortController` for the complete load.
4. Load tokenizer and model weights using the platform-specific memory profile.
5. Warm up kernels.
6. Retain ownership for the lifetime of the loaded model.

Remote testing may invoke the existing button click through the debug channel. It uses the same ownership path and cannot bypass the lock.

### 3. Bounded iOS Staging

iOS uses:

```js
{ concurrency: 1, chunkMaxBytes: 32 * 1024 * 1024 }
```

The existing patched runtime already splits tensors larger than the chunk limit and writes the oversized per-layer embedding directly into two row-tiled GPU buffers. Serial 32 MB pieces reduce transient CPU memory without changing the final GPU tensor layout.

Desktop keeps the runtime defaults because the failure is specific to Safari's mobile process budget.

This change may increase first-load time. It does not affect inference because all weights are in their existing final GPU buffers before warmup and generation begin.

### 4. Lightweight Diagnostics

The debug client continues to report:

- console output
- uncaught errors and rejected promises
- request start, status, and content length
- lifecycle and WebGPU capability information

It no longer consumes and rebuilds response bodies. Loader progress remains available through `Gemma4Mobile.load({ onProgress })`, which is the authoritative source for downloaded and prepared bytes.

This preserves debugging visibility while leaving fetch backpressure and buffering under Safari's control.

### 5. Cleanup And Recovery

If loading throws while the page is alive:

1. Abort remaining requests.
2. Dispose any returned model or runtime resources.
3. Clear debug handles and loading state.
4. Release model ownership.
5. Present a retry action.

If Safari terminates the page, the browser releases the Web Lock and closes the WebSocket. A newly opened page starts in `idle` and may acquire ownership after the old process is gone.

The app must not automatically retry after a crash because an immediate retry recreates peak pressure before iOS has reclaimed the old process.

## Public Repository Packaging

`gemma-4-e2b.pretty.js` becomes a tracked runtime source file. The ignore rule for all `*.pretty.js` files is replaced with a specific rule for disposable generated files, or the runtime is renamed to a stable tracked filename and the import is updated.

The third-party notice must distinguish the unchanged upstream minified bundle from the locally patched, de-minified runtime and describe the patch at a high level.

## Testing

### Automated

- JavaScript syntax checks for every source file.
- Unit tests for state transitions and lock acquisition using a fake Locks API.
- A two-page browser test proving only one page reaches `Gemma4Mobile.load()`.
- A test proving a blocked page performs no model weight request and creates no WebGPU model.
- A test proving failed loading releases ownership and allows a later retry.
- Existing TLS and private-key exposure test.
- Clean-clone verification proving all imported files are tracked.

### Real iPhone Acceptance

1. Open two Safari pages to the app.
2. Start loading from the first page.
3. Confirm the second page reports that another tab owns the model and makes no weight requests.
4. Confirm the first page reaches `model ready` without either debug socket disappearing.
5. Generate a short response and record time to first token and tokens per second.
6. Close the owner page, acquire ownership from the second page, and load successfully.
7. Repeat the load cycle to confirm ownership cleanup and cached-load behavior.

The fix is accepted only when the real iPhone reaches ready state and generates text while the server remains healthy and no competing page starts a second load.

## Non-Goals

- Changing model precision or model identity.
- Repacking or proxying model weights through the Mac.
- Changing generation kernels or sampling behavior.
- Supporting simultaneous independent model copies in multiple tabs.
