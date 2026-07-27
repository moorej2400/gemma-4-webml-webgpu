# iOS Memory-Safe Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemma 4 load and run reliably in iPhone Safari by preventing
duplicate model ownership and reducing avoidable transient memory without
changing inference kernels.

**Architecture:** A focused `ModelSession` module owns the origin-wide Web Lock,
and a `ModelLifecycle` module owns loading, warmup, cleanup, and disposal. The
app imports the large runtime only after lock acquisition. The debug surface
uses allowlisted commands and observes fetch metadata without replacing
response bodies.

**Tech Stack:** Browser ES modules, Web Locks API, WebGPU, Node.js built-in test
runner, dependency-free Node HTTPS/WebSocket server, iPhone Safari.

---

## File Map

- Create `model-session.mjs`: exclusive Web Lock state machine.
- Create `model-lifecycle.mjs`: idempotent model load, warmup, failure cleanup,
  and disposal orchestration.
- Create `platform-profile.mjs`: iOS detection and loader options.
- Create `weight-range-plan.mjs`: testable range splitting, coalescing, and
  bounded worker execution used by the runtime loader.
- Modify `app.js`: dynamic runtime import, explicit load, lifecycle integration,
  debug command handlers, and generation disposal coordination.
- Modify `index.html`: add a visible model disposal control.
- Modify `gemma-4-e2b.pretty.js`: make model disposal await runtime destruction.
- Modify `debug-client.js`: preserve raw fetch responses, remove startup adapter
  allocation and eval, and forward allowlisted app commands.
- Modify `server.js`: remove eval and expose allowlisted load, dispose, prompt,
  reload, and client-status commands.
- Create `tests/model-session.test.mjs`: mutual exclusion and release tests.
- Create `tests/model-lifecycle.test.mjs`: load, failure, warmup, and disposal
  tests.
- Create `tests/platform-profile.test.mjs`: mobile memory profile tests.
- Create `tests/weight-range-plan.test.mjs`: actual range and concurrency tests.
- Create `tests/browser-model-session.test.mjs`: two-page Web Locks, bfcache,
  and context-termination tests using bundled Playwright.
- Create `tests/browser-app-ownership.test.mjs`: two real app pages with a
  route-injected mock runtime proving only the owner imports or loads.
- Create `tests/model-session-harness.html`: browser test surface.
- Create `tests/debug-surface.test.mjs`: static security and buffering
  regression tests.
- Create `scripts/prepare-runtime.mjs`: authoritative runtime fetch, hash
  verification, and deterministic local preparation.
- Create `runtime-manifest.json`: authoritative URL and exact artifact hashes.
- Create `tests/clean-checkout.test.mjs`: preparation and import-resolution
  verification in an isolated temporary checkout.
- Create `tests/fixtures/model-safetensors-header.json`: hash-bound tensor
  metadata from the authoritative current model.
- Create `tests/run-tests.sh`: complete local test entrypoint.
- Modify `docs/real-iphone-safari-testing.md`: document the allowlisted
  real-device race and inference workflow.

### Task 1: Test The Exclusive Model Session

**Files:**
- Create: `tests/model-session.test.mjs`
- Create: `model-session.mjs`

- [ ] **Step 1: Write failing tests**

Cover unsupported Web Locks, one successful owner, simultaneous acquisition
where exactly one caller succeeds, a blocked caller performing no work,
idempotent release, cleanup-before-release ordering, cleanup failure retaining
ownership, and acquisition after owner-context termination in the fake lock
manager. The session module must not install a `pagehide` release handler.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
node --test tests/model-session.test.mjs
```

Expected: failure because `model-session.mjs` does not exist.

- [ ] **Step 3: Implement the lock state machine**

Export `ModelSession` and `UnsupportedModelSessionError`. Use
`locks.request(name, { mode: "exclusive", ifAvailable: true }, callback)`.
Resolve acquisition when the callback receives the lock, hold the callback on
an internal promise, and resolve that promise only after the caller's cleanup
callback succeeds.

- [ ] **Step 4: Verify tests pass**

Run `node --test tests/model-session.test.mjs`.

- [ ] **Step 5: Add real-browser lock tests**

Serve `tests/model-session-harness.html` from the project server. Use bundled
Playwright Chromium to open two same-origin pages, trigger acquisition
simultaneously, and prove exactly one owns the real browser lock. Exercise a
persisted back-forward navigation and prove the restored owner still excludes
the peer. Close the owner page without calling release and prove the peer can
then acquire.

- [ ] **Step 6: Run browser tests**

Run:

```bash
NODE_PATH=/Users/jaredmoore/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  node --test tests/browser-model-session.test.mjs
```

Expected: simultaneous exclusivity, bfcache retention, and browser-context
termination release all pass.

- [ ] **Step 7: Commit**

```bash
git add model-session.mjs tests/model-session.test.mjs tests/browser-model-session.test.mjs tests/model-session-harness.html
git commit -m "Add exclusive browser model ownership"
```

### Task 2: Test Model Lifecycle And iOS Profile

**Files:**
- Create: `tests/model-lifecycle.test.mjs`
- Create: `tests/platform-profile.test.mjs`
- Create: `tests/weight-range-plan.test.mjs`
- Create: `model-lifecycle.mjs`
- Create: `platform-profile.mjs`
- Create: `weight-range-plan.mjs`
- Create: `scripts/prepare-runtime.mjs`
- Create: `runtime-manifest.json`
- Create: `tests/fixtures/model-safetensors-header.json`
- Modify locally, keep ignored: `gemma-4-e2b.pretty.js`

- [ ] **Step 1: Write failing lifecycle tests**

Inject fake session, importer, loader, candidate model, progress callback, and
abort controller. Prove that the runtime import occurs only after ownership,
blocked pages never import or load, iOS passes `concurrency: 1` and
`chunkMaxBytes: 32 * 1024 * 1024`, a load rejection releases ownership after
runtime cleanup, warmup failure disposes the candidate before release, and
concurrent disposal calls share one promise. Prove a later retry can acquire
and become ready after each failure path.

Write executable range-planner tests against a checked, hash-bound safetensors
header fetched from the authoritative current model. Record the model URL,
revision/ETag, header length, and header SHA-256. Derive actual tensor offsets,
identify the current streamed embedding names, and prove tensors above 192 MiB
split into pieces no larger than 32 MiB, regular tensors remain unsplit,
coalescing never exceeds its cap, the largest unsplit range comes from those
actual offsets, and the worker executor observes a maximum of one active range
with iOS concurrency.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
node --test tests/model-lifecycle.test.mjs tests/platform-profile.test.mjs tests/weight-range-plan.test.mjs
```

- [ ] **Step 3: Implement the minimum lifecycle**

`ModelLifecycle.load()` acquires ownership, imports the runtime, creates one
load abort controller, loads with the platform profile, warms the candidate,
and publishes it only after warmup. `dispose()` aborts active work, waits for
it to settle, disposes candidate or published model, clears references, and
then releases ownership. Repeated calls return the same in-flight promise.

- [ ] **Step 4: Use the tested range planner in the runtime**

Create the deterministic preparation script and manifest first. It fetches the
authoritative upstream bundle, verifies its SHA-256, applies transformations
that replace the runtime's private span splitting, coalescing, and worker-loop
with imports from `weight-range-plan.mjs`, and verifies the generated output
hash. Keep thresholds, ordering, cache behavior, and default desktop
concurrency unchanged.

Extract the runtime's owned-resource try/catch into an exported
`withOwnedRuntime()` helper used by `Gemma4Mobile.load()`. Failure-injection
tests execute that real helper, create a fake allocated GPU resource, throw
after allocation, and prove `destroy()` finishes before rejection and before
session release. Regenerate the ignored local runtime and test it, but do not
stage or commit that generated derivative unless redistribution permission is
verified.

- [ ] **Step 5: Verify tests pass**

Run the same `node --test` command.

- [ ] **Step 6: Commit**

```bash
git add model-lifecycle.mjs platform-profile.mjs weight-range-plan.mjs scripts/prepare-runtime.mjs runtime-manifest.json tests/fixtures/model-safetensors-header.json tests/model-lifecycle.test.mjs tests/platform-profile.test.mjs tests/weight-range-plan.test.mjs
git commit -m "Add memory-safe model lifecycle"
```

### Task 3: Integrate Explicit Loading And Awaited Disposal

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify locally, keep ignored: `gemma-4-e2b.pretty.js`

- [ ] **Step 1: Add failing source-contract tests**

Assert that `app.js` has no automatic load timer or top-level runtime import,
loads through `ModelLifecycle`, and passes generation abort/wait hooks into
disposal. Assert that the runtime model's `dispose()` is async and awaits its
owned runtime's `destroy()`. Assert unsupported Web Locks disables loading and
shows a fail-closed unsupported-browser message distinct from a blocked-owner
message.

- [ ] **Step 2: Verify tests fail**

Run `node --test tests/app-contract.test.mjs`.

- [ ] **Step 3: Integrate lifecycle**

Remove the auto-load block and static runtime import. Keep the load button as
the only UI entry point. Render `Model active in another tab` on blocked
acquisition and `This browser cannot safely own the model` when Web Locks are
unavailable. Send GPU diagnostics from `model.deviceInfo()` after successful
ownership and loading. Add an **Unload model** header control and implement
`disposeModel()` so active generation is aborted and settled before lifecycle
disposal.

- [ ] **Step 4: Make runtime disposal await cleanup**

Change `Gemma4Mobile.dispose()` to an idempotent async method that disposes model
tensors and awaits `runtime.destroy()` when it owns the runtime. Do not change
weight layout, shaders, generation, or KV-cache behavior.

- [ ] **Step 5: Verify tests and syntax**

Open two actual `index.html` app pages with bundled Playwright. Route the
literal dynamic runtime URL to a tiny mock ES module and count route requests
plus calls. Click both real load buttons simultaneously and prove exactly one
page imports the runtime and calls `Gemma4Mobile.load()`. Assert the blocked
page shows the blocked-owner message, creates no GPU model, and issues no
model/tokenizer request.

Run:

```bash
node --test tests/app-contract.test.mjs tests/model-lifecycle.test.mjs
NODE_PATH=/Users/jaredmoore/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  node --test tests/browser-app-ownership.test.mjs
node --check app.js
node --check gemma-4-e2b.pretty.js
```

- [ ] **Step 6: Commit**

```bash
git add app.js index.html tests/app-contract.test.mjs tests/browser-app-ownership.test.mjs
git commit -m "Integrate iOS-safe model loading"
```

### Task 4: Remove Debug Memory And Ownership Bypasses

**Files:**
- Modify: `debug-client.js`
- Modify: `server.js`
- Create: `tests/debug-surface.test.mjs`

- [ ] **Step 1: Write failing debug-surface tests**

Assert there is no `eval`, `/__cmd/eval`, response reconstruction,
`ReadableStream`, `getReader()`, or startup `requestAdapter()`. Assert the
server only emits allowlisted `load-model`, `dispose-model`, `run-prompt`, and
`reload` messages.

- [ ] **Step 2: Verify tests fail**

Run `node --test tests/debug-surface.test.mjs`.

- [ ] **Step 3: Preserve fetch diagnostics without touching bodies**

Log request method, range, response status, and content length, then return the
original `Response` object unchanged.

- [ ] **Step 4: Add allowlisted commands**

The debug client dispatches a `webml-debug-command` event for recognized
commands. The app handles load, dispose, and fixed-token prompt generation
through normal application functions. The server supports broadcast commands
and reports connected client IDs; no endpoint accepts executable source.

- [ ] **Step 5: Verify tests pass**

Run `node --test tests/debug-surface.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add debug-client.js server.js tests/debug-surface.test.mjs
git commit -m "Constrain iPhone debug controls"
```

### Task 5: Make Runtime Preparation Reproducible

**Files:**
- Modify: `scripts/prepare-runtime.mjs`
- Modify: `runtime-manifest.json`
- Create: `tests/clean-checkout.test.mjs`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Verify runtime distribution permission**

Check the authoritative upstream repository or an owner statement. Record the
exact URL and evidence. Do not infer the runtime license from the model
license.

- [ ] **Step 2: Write a failing isolated-tree test**

Create a temporary checkout from an explicit Git index/tree snapshot that
includes the staged candidate files rather than `git archive HEAD`. Assert the
generated runtime is initially absent, run the preparation script against a
local hash-bound fixture or the authoritative URL, verify upstream and output
SHA-256 hashes, and prove every app import resolves. Explicitly extract and
resolve the literal dynamic runtime import from `app.js`, not only static
imports. The test must not copy ignored runtime files from the working tree.

- [ ] **Step 3: Complete deterministic preparation and docs**

Confirm `scripts/prepare-runtime.mjs` fetches the runtime only from the
manifest's authoritative URL, verifies the upstream hash before transformation,
applies the deterministic local transformations, verifies the output hash, and
writes the ignored local runtime. It exits nonzero on any mismatch. The
manifest contains the upstream URL, upstream SHA-256, output path, and patched
SHA-256.

If redistribution permission is verified, the prepared runtime may instead be
tracked with the evidence and notices. If permission is absent, neither the
upstream artifact nor generated derivative is added to a new public commit.
Untrack the already-published `gemma-4-e2b.js` with `git rm --cached` and add
it to `.gitignore`; this preserves the existing local file while removing it
from future repository trees. Clean checkouts then fetch and hash-verify the
authoritative upstream artifact through the preparation script.

- [ ] **Step 4: Verify the isolated checkout**

Stage the complete candidate file set, create a temporary tree with
`git write-tree`, and run:

```bash
node --test tests/clean-checkout.test.mjs
```

Expected: preparation is hash-verified and all imports resolve from the
isolated checkout.

- [ ] **Step 5: Commit**

```bash
git rm --cached gemma-4-e2b.js
git add scripts/prepare-runtime.mjs runtime-manifest.json tests/clean-checkout.test.mjs .gitignore README.md THIRD_PARTY_NOTICES.md
git commit -m "Make runtime preparation reproducible"
```

### Task 6: Complete Automated Verification

**Files:**
- Create: `tests/run-tests.sh`
- Modify: `tests/verify-ios-tls.sh`

- [ ] **Step 1: Add the aggregate test runner**

Run every `*.test.mjs`, JavaScript syntax checks, the TLS test, and checks that
private keys, backup bundles, debug logs, and local certificates are untracked.
Include the bundled-Playwright browser suite and isolated-checkout preparation
test.

- [ ] **Step 2: Run the complete suite**

Run:

```bash
bash tests/run-tests.sh
```

Expected: all Node tests pass, all syntax checks pass, TLS certificate
verification succeeds, private certificate keys return HTTP 404, and the
repository hygiene checks pass.

- [ ] **Step 3: Inspect the diff**

Run:

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

- [ ] **Step 4: Commit**

```bash
git add tests/run-tests.sh tests/verify-ios-tls.sh
git commit -m "Add iOS loader regression suite"
```

### Task 7: Verify On The Real iPhone

**Files:**
- Modify: `docs/real-iphone-safari-testing.md`

- [ ] **Step 1: Restart the LAN server**

Restart the `gemma-webgpu` tmux session from this branch and confirm:

```bash
curl -skI https://127.0.0.1:8443/
curl -sk https://127.0.0.1:8443/__cmd/clients
```

- [ ] **Step 2: Reload two connected Safari pages**

Broadcast reload, wait for two iPhone debug clients, then broadcast
`load-model` once so both pages attempt acquisition from the same command.

- [ ] **Step 3: Prove exclusive ownership**

Confirm logs show exactly one `Gemma4Mobile.load()` start, the second client
reports blocked ownership, only the owner issues model weight ranges, and both
debug sockets remain connected.

- [ ] **Step 4: Prove model readiness and inference**

Wait for `model ready`, send the allowlisted fixed prompt with a fixed token
limit, and confirm a non-empty response plus TTFT and tokens-per-second metrics.
Keep the iPhone on external power at a stable, non-throttled temperature. Reset
the conversation before each run, use the same prompt and generated-token
count, repeat three times, and compare median steady-state throughput with the
same-device baseline. The median may not regress by more than 5%; record TTFT
for observation.

- [ ] **Step 5: Prove bfcache ownership**

Background and restore the owner page. Confirm the peer remains blocked, the
owner did not reload a second model, and the restored owner still generates.

- [ ] **Step 6: Prove release and reacquisition**

Use the visible unload control or allowlisted `dispose-model`, verify GPU
cleanup completes before lock release, then prove a former blocked page can
acquire and load.

- [ ] **Step 7: Prove abrupt termination recovery**

Terminate the owner tab without explicit disposal. Confirm Safari releases its
browser context and a peer can acquire. Complete one more cached load and
generation cycle.

- [ ] **Step 8: Document exact commands and evidence**

Update the real-iPhone testing guide with the final endpoints, expected log
markers, failure interpretation, and measured result.

- [ ] **Step 9: Commit**

```bash
git add docs/real-iphone-safari-testing.md
git commit -m "Document real iPhone loader verification"
```

### Task 8: Publication Gate And Final Audit

- [ ] **Step 1: Run completion audit**

Map every design requirement to a test result, source inspection, server log,
or real-device result. Treat missing phone evidence as incomplete.

- [ ] **Step 2: Commit and publish only the verified state**

Push the branch only after the complete suite, real-iPhone test, repository
hygiene, and runtime permission gate all pass.
