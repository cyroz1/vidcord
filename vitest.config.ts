import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Mock Tauri runtime APIs so pure helpers can be imported in Node
    alias: {
      "@tauri-apps/api/core": new URL(
        "./src/__mocks__/@tauri-apps/api/core.ts",
        import.meta.url
      ).pathname,
      "@tauri-apps/api/event": new URL(
        "./src/__mocks__/@tauri-apps/api/event.ts",
        import.meta.url
      ).pathname,
      "@tauri-apps/plugin-notification": new URL(
        "./src/__mocks__/@tauri-apps/plugin-notification.ts",
        import.meta.url
      ).pathname,
    },
  },
});
