import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "react";
          }
          // Keep the user-gesture-only opener out of the startup Tauri chunk.
          // The dialog plugin is loaded eagerly so native file/folder pickers
          // cannot fail on a stale late-loaded module after a WebView refresh.
          if (id.includes("node_modules/@tauri-apps/plugin-opener")) {
            return "tauri-opener";
          }
          if (id.includes("node_modules/@tauri-apps/")) {
            return "tauri";
          }
        },
      },
    },
  },
}));
