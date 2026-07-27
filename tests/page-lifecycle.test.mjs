import assert from "node:assert/strict";
import test from "node:test";

import { installPageLifecycle } from "../page-lifecycle.mjs";

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };
}

test("real page termination starts model disposal", async () => {
  const window = fakeWindow();
  let disposals = 0;
  installPageLifecycle({
    window,
    dispose: () => {
      disposals += 1;
      return Promise.resolve();
    },
  });

  window.dispatch("pagehide", { persisted: false });

  assert.equal(disposals, 1);
});

test("back-forward cache pagehide retains the model", async () => {
  const window = fakeWindow();
  let disposals = 0;
  installPageLifecycle({
    window,
    dispose: () => {
      disposals += 1;
      return Promise.resolve();
    },
  });

  window.dispatch("pagehide", { persisted: true });

  assert.equal(disposals, 0);
});
