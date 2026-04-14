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
          // Split Tauri plugin code out of the entry chunk so the initial
          // paint ships less JS. plugin-dialog/plugin-opener are only used
          // on-demand (after a user gesture) and the core API is lightweight
          // enough to keep separate from the main app logic.
          if (id.includes("node_modules/@tauri-apps/")) {
            return "tauri";
          }
        },
      },
    },
  },
}));
