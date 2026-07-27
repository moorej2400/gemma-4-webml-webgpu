/**
 * Releases GPU ownership when this document is actually being replaced.
 *
 * Safari may retain a page after a persisted pagehide, so that case must keep
 * the model alive. Reloads and real navigations are not persisted and need to
 * start disposal before the replacement document can allocate another device.
 */
export function installPageLifecycle({
  window = globalThis.window,
  dispose,
  onError = (error) => console.error("[app] page teardown failed:", error),
}) {
  const onPageHide = (event) => {
    if (event.persisted) return;
    Promise.resolve(dispose()).catch(onError);
  };

  window.addEventListener("pagehide", onPageHide);
  return () => window.removeEventListener("pagehide", onPageHide);
}
