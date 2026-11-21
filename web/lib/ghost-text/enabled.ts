const KEY = "deeptutor.ghostText";
const EVENT = "deeptutor:ghost-text-changed";

export function ghostTextEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // On by default: the feature is useless unless users know to hunt for the
  // icon toggle. An explicit "0" still turns it off.
  return window.localStorage.getItem(KEY) !== "0";
}

export function setGhostTextEnabled(enabled: boolean): void {
  window.localStorage.setItem(KEY, enabled ? "1" : "0");
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeGhostText(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
