type DialogSelection = string | string[] | null;

interface E2EDialogMocks {
  openQueue: DialogSelection[];
  saveQueue: Array<string | null>;
  calls: { open: number; save: number };
  errors: string[];
}

declare global {
  interface Window {
    __VIDCORD_E2E_DIALOGS__?: E2EDialogMocks;
  }
}

export function initializeE2EDialogMocks(): void {
  const mocks: E2EDialogMocks = {
    openQueue: [],
    saveQueue: [],
    calls: { open: 0, save: 0 },
    errors: [],
  };
  window.__VIDCORD_E2E_DIALOGS__ = mocks;
  window.addEventListener(
    "error",
    (event) => mocks.errors.push(event.error?.stack ?? event.message),
    true
  );
  window.addEventListener("unhandledrejection", (event) => {
    mocks.errors.push(String(event.reason?.stack ?? event.reason));
  });
}

export async function open(): Promise<DialogSelection> {
  if (window.__VIDCORD_E2E_DIALOGS__) window.__VIDCORD_E2E_DIALOGS__.calls.open += 1;
  return window.__VIDCORD_E2E_DIALOGS__?.openQueue.shift() ?? null;
}

export async function save(): Promise<string | null> {
  if (window.__VIDCORD_E2E_DIALOGS__) window.__VIDCORD_E2E_DIALOGS__.calls.save += 1;
  return window.__VIDCORD_E2E_DIALOGS__?.saveQueue.shift() ?? null;
}
