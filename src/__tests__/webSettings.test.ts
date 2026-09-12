import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_SETTINGS,
  loadBrowserSettings,
  normalizeBrowserSettings,
  saveBrowserSettings,
} from "../web/webSettings";

type StorageStub = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

const originalWindow = globalThis.window;

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  const storage: StorageStub = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return values;
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("browser settings persistence", () => {
  it("migrates the legacy browser key to the semantic GIF target", () => {
    const values = installStorage({
      "vidcord.browser.settings.v1": JSON.stringify({ gifQualityIndex: 1 }),
    });

    expect(loadBrowserSettings().gifTargetMb).toBe(20);
    expect(values.has("vidcord.browser.settings.v2")).toBe(false);
  });

  it("writes semantic GIF targets to the versioned browser key", () => {
    const values = installStorage();
    const settings = normalizeBrowserSettings({ ...DEFAULT_BROWSER_SETTINGS, gifTargetMb: 10 });

    saveBrowserSettings(settings);

    expect(JSON.parse(values.get("vidcord.browser.settings.v2") ?? "{}")).toMatchObject({
      gifTargetMb: 10,
    });
  });
});
