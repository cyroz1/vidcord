import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");
const isTauri = "__TAURI_INTERNALS__" in window;
const NativeApp = lazy(() => import("./App"));
const BrowserApp = lazy(() => import("./web/WebApp"));
const RootApp = isTauri ? NativeApp : BrowserApp;

function applyNativeWindowTheme(): void {
  if (!isTauri) return;
  void import("./ipc")
    .then(({ syncNativeWindowTheme }) => syncNativeWindowTheme(systemDarkMode.matches))
    .catch((error: unknown) => console.warn("Unable to sync the native window theme", error));
}

applyNativeWindowTheme();
systemDarkMode.addEventListener("change", applyNativeWindowTheme);

async function mountApplication(): Promise<void> {
  if (import.meta.env.VITE_VIDCORD_E2E === "1") {
    const { initializeE2EDialogMocks } = await import("./e2eDialog");
    initializeE2EDialogMocks();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Suspense fallback={<div className="app-boot-screen">Loading vidcord…</div>}>
          <RootApp />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

void mountApplication();
