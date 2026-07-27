# Chat-First Model Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load Gemma on the first submitted prompt while keeping manual model controls hidden unless enabled in Settings.

**Architecture:** A small submission coordinator serializes first-load and generation so one prompt is retained and sent once. A preference helper owns safe local-storage access. The existing app wires both modules into its composer, seed prompts, model lifecycle, and a compact header settings popover.

**Tech Stack:** Browser ES modules, DOM APIs, Web Locks, WebGPU lifecycle, Node.js test runner, HTML/CSS.

---

### Task 1: First-Submission Coordinator

**Files:**
- Create: `submission-flow.mjs`
- Create: `tests/submission-flow.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing coordinator tests**

Cover loading before generation, preserving a prompt on load failure, and
sharing one in-flight submission:

```js
const flow = new SubmissionFlow({
  isReady: () => ready,
  load: async () => { loadCalls += 1; ready = loadSucceeds; },
  generate: async (prompt) => generated.push(prompt),
});

await flow.submit("hello");
assert.equal(loadCalls, 1);
assert.deepEqual(generated, ["hello"]);
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test tests/submission-flow.test.mjs
```

Expected: failure because `submission-flow.mjs` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create a focused class:

```js
export class SubmissionFlow {
  #isReady;
  #load;
  #generate;
  #inFlight = null;

  constructor({ isReady, load, generate }) {
    this.#isReady = isReady;
    this.#load = load;
    this.#generate = generate;
  }

  submit(prompt) {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#run(prompt).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(prompt) {
    if (!this.#isReady()) await this.#load();
    if (!this.#isReady()) return { status: "not-ready", prompt };
    await this.#generate(prompt);
    return { status: "sent", prompt };
  }
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test tests/submission-flow.test.mjs
npm test
```

Expected: all tests pass.

### Task 2: Persisted Manual-Control Preference

**Files:**
- Create: `manual-controls-preference.mjs`
- Create: `tests/manual-controls-preference.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing preference tests**

Test default false, persisted true/false values, writes, and unavailable storage:

```js
assert.equal(readManualControlsPreference(storage), false);
writeManualControlsPreference(storage, true);
assert.equal(storage.getItem("gemma.showManualModelControls"), "true");
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test tests/manual-controls-preference.test.mjs
```

Expected: failure because the preference module does not exist.

- [ ] **Step 3: Implement safe preference access**

Use one origin-scoped key and fail closed:

```js
const KEY = "gemma.showManualModelControls";

export function readManualControlsPreference(storage = globalThis.localStorage) {
  try { return storage?.getItem(KEY) === "true"; }
  catch { return false; }
}

export function writeManualControlsPreference(value, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, String(Boolean(value))); }
  catch {}
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test tests/manual-controls-preference.test.mjs
npm test
```

Expected: all tests pass.

### Task 3: Chat-First App Flow

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `tests/app-contract.test.mjs`

- [ ] **Step 1: Write failing app contract tests**

Assert the input and seeds are available before model loading, the app delegates
through `SubmissionFlow`, generation receives a retained prompt argument, and
manual controls are hidden by default.

- [ ] **Step 2: Verify the contract tests fail**

Run:

```bash
node --test tests/app-contract.test.mjs
```

Expected: assertions fail against the disabled composer and direct send path.

- [ ] **Step 3: Wire first-send loading**

Enable the composer at boot. Make `send()` delegate to `SubmissionFlow`; make
`generateMessage(prompt, options)` clear the composer only after the model is
ready. While loading, disable Send but retain the text. On failure, restore the
normal send state so the same prompt can retry.

Seed clicks set the input text and call the same `send()` function regardless of
model state.

- [ ] **Step 4: Update idle and loading copy**

Use `Ask anything...` before loading. Change welcome copy to explain that the
model loads on the first message without exposing implementation details.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test tests/app-contract.test.mjs
npm test
```

Expected: all tests pass.

### Task 4: Settings Popover

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `tests/app-contract.test.mjs`

- [ ] **Step 1: Write failing settings UI tests**

Assert an accessible Settings button, popover, checkbox, default-hidden manual
control container, preference reads/writes, and Escape/outside-click handlers.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test tests/app-contract.test.mjs
```

Expected: settings contract assertions fail.

- [ ] **Step 3: Build the popover**

Add an icon-only gear button and an anchored popover with one switch row:
`Show manual model controls`. Reuse existing color variables, borders, compact
type, 8px-or-less panel radius, 44px mobile target sizing, and visible focus
states. Keep the popover within the iPhone viewport.

- [ ] **Step 4: Wire preference and dismissal**

Read the preference at startup, toggle the manual-control container without
affecting model state, persist changes, and close on outside click or Escape.
Update `aria-expanded` and `hidden` state together.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test tests/app-contract.test.mjs
npm test
```

Expected: all tests pass.

### Task 5: Browser And Physical Verification

**Files:**
- Modify only if verification reveals a defect.

- [ ] **Step 1: Run real-browser ownership tests**

Run:

```bash
NODE_PATH=/Users/jaredmoore/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  node --test tests/browser-model-session.test.mjs tests/browser-app-ownership.test.mjs
bash tests/verify-ios-tls.sh
```

Expected: all browser tests and the certificate check pass.

- [ ] **Step 2: Inspect desktop and mobile layouts**

Use browser screenshots at 1280x800 and 440x796. Verify the composer is usable
before load, the Settings panel does not overlap or shift content, controls fit,
and manual controls are absent by default.

- [ ] **Step 3: Verify the physical iPhone flow**

On iPhone Safari:

1. Enter a prompt before loading.
2. Submit once and verify model loading starts.
3. Verify the prompt remains visible during loading.
4. Verify generation starts once after Ready.
5. Reload, submit again, and verify the page remains alive.
6. Enable manual controls in Settings and verify Load/Unload appear.

- [ ] **Step 4: Final checks and publish**

Run:

```bash
git diff --check
npm test
git status --short
```

Commit the feature, push the working branch, fast-forward public `main`, and
verify both remote refs point to the feature commit.
