import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY, initializeTheme, setTheme } from "@/lib/theme";

type SchemeListener = (event: { matches: boolean; media: string }) => void;

function installColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<SchemeListener>();
  const query = "(prefers-color-scheme: dark)";
  const media = {
    get matches() {
      return dark;
    },
    media: query,
    onchange: null as ((event: { matches: boolean; media: string }) => void) | null,
    addListener(listener: SchemeListener) {
      listeners.add(listener);
    },
    removeListener(listener: SchemeListener) {
      listeners.delete(listener);
    },
    addEventListener(_type: string, listener: SchemeListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: SchemeListener) {
      listeners.delete(listener);
    },
    dispatchEvent() {
      return false;
    },
    listenerCount() {
      return listeners.size;
    },
    setDark(next: boolean) {
      dark = next;
      const event = { matches: next, media: query };
      for (const listener of [...listeners]) listener(event);
    },
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (requested: string) =>
      requested === query
        ? media
        : {
            matches: false,
            media: requested,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() {
              return false;
            },
          },
  });

  return media;
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});

describe("system theme follows the OS", () => {
  it("does not persist the first-visit fallback and updates when the OS scheme changes", () => {
    const media = installColorScheme(false);

    expect(initializeTheme()).toBe("snow");
    expect(document.documentElement.classList.contains("theme-snow")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    media.setDark(true);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-snow")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps an explicit theme when the OS scheme changes", () => {
    const media = installColorScheme(true);

    // Subscribe first, the way the app shell does, then pick a palette.
    // setTheme alone never attaches a listener, so this is what proves detach.
    initializeTheme();
    expect(media.listenerCount()).toBe(1);
    setTheme("glass");
    expect(media.listenerCount()).toBe(0);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("glass");
    expect(document.documentElement.classList.contains("theme-glass")).toBe(true);

    media.setDark(false);

    expect(document.documentElement.classList.contains("theme-glass")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("glass");
  });

  it("stores an explicit system choice without freezing the resolved palette", () => {
    const media = installColorScheme(true);

    setTheme("system");

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-snow")).toBe(false);

    media.setDark(false);

    expect(document.documentElement.classList.contains("theme-snow")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("reloads a stored system preference without rewriting the resolved palette", () => {
    const media = installColorScheme(false);
    localStorage.setItem(THEME_STORAGE_KEY, "system");

    expect(initializeTheme()).toBe("snow");
    expect(document.documentElement.classList.contains("theme-snow")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    media.setDark(true);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });
});

describe("appearance settings", () => {
  it("offers a System option alongside the explicit themes", () => {
    const source = readFileSync(
      path.join(process.cwd(), "features", "settings", "sections", "AppearanceSettingsSection.tsx"),
      "utf8",
    );

    expect(source).toMatch(/id:\s*"system"/);
    expect(source).toMatch(/label:\s*"System"/);
  });

  it("starts the live system listener from the app shell", () => {
    const source = readFileSync(path.join(process.cwd(), "context", "AppShellContext.tsx"), "utf8");

    expect(source).toMatch(/initializeTheme\s*\(/);
  });
});
