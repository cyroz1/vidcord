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
          // Keep user-gesture-only plugins out of the startup Tauri chunk.
          // App.tsx imports these dynamically, so each remains deferred until
          // the file picker or an external link is actually opened.
          if (id.includes("node_modules/@tauri-apps/plugin-dialog")) {
            return "tauri-dialog";
          }
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
