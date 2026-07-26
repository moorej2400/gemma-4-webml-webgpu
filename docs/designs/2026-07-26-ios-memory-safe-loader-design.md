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
- iOS must issue only one weight range request at a time. Oversized streamable
  tensors use 32 MB pieces; regular tensors retain their existing range size.
- Weight responses must flow directly from `fetch` to the runtime loader.
- Load failure must dispose partial GPU state and release ownership when the page survives.
- Browser-context termination must release ownership automatically.
- Desktop loading may retain its current parallel settings.
- Generation code, model tensors, WebGPU kernels, and KV-cache behavior must remain unchanged.
- A clean checkout must have a documented, reproducible way to produce every
  runtime file required by `app.js`.

## Architecture

### 1. Model Session Owner

A small `model-session.js` module owns the browser-wide model lease.

It uses the Web Locks API with an exclusive lock named
`gemma-4-webgpu-model`. The lock request uses `ifAvailable: true`, so a second
page is rejected immediately instead of waiting while consuming resources. The
owning page holds the lock with an unresolved promise for the model lifetime.
It releases the lock only after explicit model disposal. Browser-context
termination releases Web Locks automatically.

There is no `BroadcastChannel` fallback. A peer-election protocol cannot prove
exclusive ownership when iOS suspends a page while its GPU resources remain
alive. If Web Locks is unavailable, loading fails closed with an unsupported
browser message.

`pagehide` with `event.persisted === true` does not release ownership because
the page and its WebGPU state may be restored from the back-forward cache.
Ownership remains attached to the live document until explicit disposal or
browser-context termination.

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
2. If unavailable, show `Model active in another tab` and do not create a GPU
   adapter, import the model runtime, or fetch model files.
3. Create an `AbortController` for the complete load.
4. Load tokenizer and model weights using the platform-specific memory profile.
5. Warm up kernels.
6. Retain ownership for the lifetime of the loaded model.

Remote testing uses an allowlisted `load-model` debug command that invokes this
same function. The debug server and client remove arbitrary JavaScript
evaluation entirely, so a remote command cannot dynamically import the runtime
or create a second loading entry point.

### 3. Reduced iOS Staging

iOS uses:

```js
{ concurrency: 1, chunkMaxBytes: 32 * 1024 * 1024 }
```

The existing patched runtime writes the oversized per-layer embedding directly
into two row-tiled GPU buffers using pieces no larger than 32 MB. Other tensor
groups are not piecewise: they retain their existing individual ranges. The
largest verified unsplit tensor in the current weight plan is approximately
96 MiB. Therefore this profile guarantees one range request in flight, not a
universal 32 MB peak.

Serial loading removes the current two-range overlap. It reduces worst-case
download staging from roughly two maximum individual ranges to one while
leaving the final GPU tensor layout unchanged. Converting every weight handler
to a streamed transform is intentionally excluded because it would be a broad,
high-risk runtime rewrite and is not needed to address the observed duplicate
model failure.

Desktop keeps the runtime defaults because the failure is specific to Safari's mobile process budget.

This change may increase first-load time. It does not affect inference because all weights are in their existing final GPU buffers before warmup and generation begin.

### 4. Lightweight Diagnostics

Before model ownership is acquired, the debug client reports:

- console output
- uncaught errors and rejected promises
- request start, status, and content length
- lifecycle and basic WebGPU capability information

It no longer consumes and rebuilds response bodies. Loader progress remains available through `Gemma4Mobile.load({ onProgress })`, which is the authoritative source for downloaded and prepared bytes.

This preserves debugging visibility while leaving fetch backpressure and buffering under Safari's control.

The debug client does not request a GPU adapter during startup. Adapter details
are collected after ownership is acquired, reusing the model initialization
path where possible.

### 5. Cleanup And Recovery

The candidate model remains local until loading and warmup both succeed. It is
published to application state only after warmup.

The app exposes one idempotent `disposeModel()` operation to the UI and an
allowlisted `dispose-model` debug command. It:

1. Changes state to `releasing` so no new load or generation can start.
2. Aborts an active load or generation and waits for it to settle.
3. Awaits loader/runtime cleanup of partial allocations.
4. Disposes the unpublished candidate or published model and its GPU resources.
5. Clears application and debug references.
6. Resolves the ownership promise only after GPU cleanup has completed.
7. Returns to `idle`.

Repeated disposal calls share the same in-flight promise and do not release
ownership early. The runtime loader contract requires any rejection to await
cleanup of resources it allocated before the rejection reaches app code.

If loading throws while the page is alive:

1. Abort remaining requests.
2. Await runtime cleanup for partially allocated resources.
3. Dispose the candidate model if one was returned, including a warmup failure.
4. Clear debug handles and application loading state.
5. Release model ownership only after cleanup completes.
6. Present a retry action.

If Safari terminates the page, the browser releases the Web Lock and closes the WebSocket. A newly opened page starts in `idle` and may acquire ownership after the old process is gone.

The app must not automatically retry after a crash because an immediate retry recreates peak pressure before iOS has reclaimed the old process.

## Public Repository Packaging

The current public checkout is not reproducible because `app.js` imports an
ignored patched runtime. The repository will include:

- exact SHA-256 hashes for the upstream and patched artifacts
- a deterministic patch or generation procedure
- third-party notices that distinguish upstream code from local changes
- a clean-checkout verification script

The upstream runtime does not currently declare a redistribution license.
Local testing may use already-downloaded artifacts, but public distribution of
the currently tracked upstream bundle, a patched bundle, or a derived patch is
gated on verified upstream permission or license terms. Until then, a
permission-compliant public checkout must fetch the runtime from its
authoritative upstream origin during a local preparation step and verify its
hash; it must not redistribute upstream source or derived code. The project
must not imply that the model's Apache-2.0 license also covers the runtime.

## Testing

### Automated

- JavaScript syntax checks for every source file.
- Unit tests for state transitions and lock acquisition using a fake Locks API.
- A simultaneous-acquisition test in which two pages click load at the same
  time and exactly one enters model loading.
- A two-page browser test proving only one page reaches `Gemma4Mobile.load()`.
- A test proving a blocked page performs no model weight request and creates no WebGPU model.
- A test proving failed loading releases ownership and allows a later retry.
- Failure-injection tests after GPU allocation and during warmup proving
  candidate resources are destroyed before ownership is released.
- A back-forward-cache test proving persisted `pagehide` does not release the
  lock and restore does not start another load.
- An abrupt-owner-termination test proving a new page can acquire the browser
  released lock.
- An unsupported-Web-Locks test proving the app fails closed.
- A loader-profile test proving iOS uses one request worker, 32 MB pieces for
  streamable oversized tensors, no response-body reconstruction, and at most
  one simultaneous model-range fetch. The test derives and records the largest
  unsplit range from the current weight plan instead of hard-coding a claimed
  universal byte cap.
- Existing TLS and private-key exposure test.
- Clean-checkout verification proving all required runtime artifacts can be
  produced and imports resolve.

### Real iPhone Acceptance

1. Open two Safari pages to the app and connect both debug clients.
2. Send the allowlisted `load-model` command to both clients concurrently.
3. Confirm exactly one page starts loading; the other reports that another tab
   owns the model and makes no model weight requests.
4. Confirm the first page reaches `model ready` without either debug socket disappearing.
5. With the phone on external power and at a stable, non-throttled temperature,
   reset the conversation before each run, send the same fixed prompt, and
   generate the same fixed token count three times. Compare against a
   same-device baseline captured under the same conditions. Median steady-state
   tokens per second may not regress by more than 5%; time to first token is
   recorded for observation but is not an acceptance threshold because loading
   and inference ownership changes do not alter generation kernels.
6. Background and restore the owner page; confirm the second page remains
   blocked and the owner can still generate.
7. Explicitly dispose the owner model, acquire ownership from the second page,
   and load successfully.
8. Terminate the owner page and confirm another page can acquire after Safari
   releases the browser context.
9. Repeat the load cycle to confirm ownership cleanup and cached-load behavior.

The fix is accepted only when the real iPhone reaches ready state and generates text while the server remains healthy and no competing page starts a second load.

## Non-Goals

- Changing model precision or model identity.
- Repacking or proxying model weights through the Mac.
- Changing generation kernels or sampling behavior.
- Supporting simultaneous independent model copies in multiple tabs.
