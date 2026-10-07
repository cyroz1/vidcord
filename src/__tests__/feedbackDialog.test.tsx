// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import FeedbackDialog, { FEEDBACK_EMAIL } from "../components/FeedbackDialog";
import { collectBugReport } from "../ipc";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("../ipc", () => ({ collectBugReport: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => root!.render(<FeedbackDialog onClose={() => {}} />));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

const REPORT = {
  subject: "Vidcord 7.6.0 bug report",
  body: "user description\n\n---\nApp version: 7.6.0",
  reportPath: "/tmp/vidcord-bug-report-1.txt",
};

it("renders the description box and explains what gets included", async () => {
  await mount();
  const textarea = container!.querySelector("textarea");
  expect(textarea).not.toBeNull();
  expect(container!.textContent).toContain("last 100 lines of the app log");
  expect(container!.textContent).toContain(FEEDBACK_EMAIL);
});

it("sends the typed description and opens the mail app with the report", async () => {
  vi.mocked(collectBugReport).mockResolvedValue(REPORT);
  await mount();

  const textarea = container!.querySelector("textarea")!;
  // Set the value the React way so onChange fires.
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    nativeSetter.call(textarea, "export blew up");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const sendButton = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Open email app")
  )!;
  await act(async () => sendButton.click());

  expect(collectBugReport).toHaveBeenCalledWith("export blew up");
  const mailto = vi.mocked(openUrl).mock.calls[0][0] as string;
  expect(mailto.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`)).toBe(true);
  expect(mailto).toContain(encodeURIComponent(REPORT.subject));
  expect(mailto).toContain(encodeURIComponent(REPORT.body));
  expect(container!.textContent).toContain(REPORT.reportPath);
});

it("passes null when the description is left empty", async () => {
  vi.mocked(collectBugReport).mockResolvedValue(REPORT);
  await mount();

  const sendButton = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Open email app")
  )!;
  await act(async () => sendButton.click());

  expect(collectBugReport).toHaveBeenCalledWith(null);
});

it("shows an error when report collection fails", async () => {
  vi.mocked(collectBugReport).mockRejectedValue(new Error("disk full"));
  await mount();

  const sendButton = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Open email app")
  )!;
  await act(async () => sendButton.click());

  expect(container!.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  expect(openUrl).not.toHaveBeenCalled();
});
