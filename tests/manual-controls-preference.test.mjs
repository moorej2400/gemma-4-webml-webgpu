import assert from "node:assert/strict";
import test from "node:test";

import {
  readManualControlsPreference,
  writeManualControlsPreference,
} from "../manual-controls-preference.mjs";

const KEY = "gemma.showManualModelControls";

function createStorage(initialValue = null) {
  let storedValue = initialValue;
  return {
    getItem(key) {
      assert.equal(key, KEY);
      return storedValue;
    },
    setItem(key, value) {
      assert.equal(key, KEY);
      storedValue = value;
    },
  };
}

test("defaults to false when the preference is absent", () => {
  assert.equal(readManualControlsPreference(createStorage()), false);
});

test("returns true only for the exact stored string true", () => {
  assert.equal(readManualControlsPreference(createStorage("true")), true);

  for (const value of ["false", "TRUE", "1", "", null]) {
    assert.equal(readManualControlsPreference(createStorage(value)), false);
  }
});

test("writes boolean values as strings under the preference key", () => {
  const trueStorage = createStorage();
  const falseStorage = createStorage();

  writeManualControlsPreference(true, trueStorage);
  writeManualControlsPreference(false, falseStorage);

  assert.equal(trueStorage.getItem(KEY), "true");
  assert.equal(falseStorage.getItem(KEY), "false");
});

test("coerces written values to booleans before storing", () => {
  const truthyStorage = createStorage();
  const falsyStorage = createStorage();

  writeManualControlsPreference("enabled", truthyStorage);
  writeManualControlsPreference(0, falsyStorage);

  assert.equal(truthyStorage.getItem(KEY), "true");
  assert.equal(falsyStorage.getItem(KEY), "false");
});

test("fails closed when storage is unavailable", () => {
  assert.equal(readManualControlsPreference(undefined), false);
  assert.doesNotThrow(() => writeManualControlsPreference(true, undefined));
});

test("fails closed when storage access throws", () => {
  const storage = {
    getItem() {
      throw new Error("read denied");
    },
    setItem() {
      throw new Error("write denied");
    },
  };

  assert.equal(readManualControlsPreference(storage), false);
  assert.doesNotThrow(() => writeManualControlsPreference(true, storage));
});

test("fails closed when the global localStorage getter throws", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("storage denied", "SecurityError");
    },
  });

  try {
    assert.equal(readManualControlsPreference(), false);
    assert.doesNotThrow(() => writeManualControlsPreference(true));
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});
