const KEY = "gemma.showManualModelControls";

function resolveStorage(storage) {
  // Opaque origins can throw SecurityError while reading the global getter itself.
  return storage === undefined ? globalThis.localStorage : storage;
}

export function readManualControlsPreference(storage = undefined) {
  try {
    return resolveStorage(storage)?.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function writeManualControlsPreference(
  value,
  storage = undefined,
) {
  try {
    resolveStorage(storage)?.setItem(KEY, String(Boolean(value)));
  } catch {}
}
