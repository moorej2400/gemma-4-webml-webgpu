const KEY = "gemma.showManualModelControls";

export function readManualControlsPreference(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function writeManualControlsPreference(
  value,
  storage = globalThis.localStorage,
) {
  try {
    storage?.setItem(KEY, String(Boolean(value)));
  } catch {}
}
