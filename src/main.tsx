import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");
const isTauri = "__TAURI_INTERNALS__" in window;
const RootApp = lazy(() => (isTauri ? import("./App") : import("./web/WebApp")));

function applyNativeWindowTheme(): void {
  if (!isTauri) return;
  void import("./ipc")
    .then(({ syncNativeWindowTheme }) => syncNativeWindowTheme(systemDarkMode.matches))
    .catch((error: unknown) => console.warn("Unable to sync the native window theme", error));
}

applyNativeWindowTheme();
systemDarkMode.addEventListener("change", applyNativeWindowTheme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<div className="app-boot-screen">Loading vidcord…</div>}>
        <RootApp />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>
);
