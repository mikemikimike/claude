import { vi } from "vitest";

/**
 * Installs an in-memory localStorage on the global scope for a component test.
 *
 * Needed because Node 22 ships its own experimental `localStorage` global that
 * shadows the happy-dom one, and it is not usable here (it warns
 * "`--localstorage-file` was provided without a valid path" and has no working
 * `clear`). Component code referencing the bare `localStorage` identifier picks
 * up whichever global is in scope, so we stub it explicitly.
 *
 * Returns a reset() to call from afterEach; vi.unstubAllGlobals() also works.
 */
export function stubLocalStorage(): { reset: () => void } {
  return stubWebStorage("localStorage");
}

/**
 * The sessionStorage twin of the above. `sessionStorage` survives a component
 * unmount but not a page load, which is exactly the lifetime the invite page's
 * once-per-session auto-signup guard needs (#425) — so a test that re-renders
 * the page must see the same store, and one that calls reset() must not.
 */
export function stubSessionStorage(): { reset: () => void } {
  return stubWebStorage("sessionStorage");
}

function stubWebStorage(name: "localStorage" | "sessionStorage"): { reset: () => void } {
  const store = new Map<string, string>();
  const stub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal(name, stub);
  return { reset: () => store.clear() };
}
