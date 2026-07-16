import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { syncNativeWindowTheme } from "./ipc";
import "./index.css";

const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");

function applyNativeWindowTheme(): void {
  void syncNativeWindowTheme(systemDarkMode.matches).catch((error: unknown) =>
    console.warn("Unable to sync the native window theme", error)
  );
}

applyNativeWindowTheme();
systemDarkMode.addEventListener("change", applyNativeWindowTheme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
