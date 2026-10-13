// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import FeedbackSection from "../web/FeedbackSection";
import { FEEDBACK_ENDPOINT } from "../feedback";
import { sendBugReport } from "../feedback";

vi.mock("../feedback", async (importOriginal) => {
  const original = await importOriginal<typeof import("../feedback")>();
  return { ...original, sendBugReport: vi.fn() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => root!.render(<FeedbackSection />));
}

function setTextarea(text: string) {
  const textarea = container!.querySelector("textarea")!;
  return act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    nativeSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton() {
  return container!.querySelector("button.feedback-send") as HTMLButtonElement;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

it("renders the feedback section with a disabled send button when empty", async () => {
  await mount();
  expect(container!.querySelector("#feedback")).not.toBeNull();
  expect(container!.querySelector("textarea")).not.toBeNull();
  expect(sendButton().disabled).toBe(true);
});

it("sends the description with browser context", async () => {
  vi.mocked(sendBugReport).mockResolvedValue(undefined);
  await mount();
  await setTextarea("the demo froze");
  expect(sendButton().disabled).toBe(false);
  await act(async () => sendButton().click());

  expect(sendBugReport).toHaveBeenCalledOnce();
  const report = vi.mocked(sendBugReport).mock.calls[0][0];
  expect(report.subject).toBe("Vidcord website feedback");
  expect(report.body).toContain("the demo froze");
  expect(report.body).toContain("Browser:");
  expect(container!.querySelector('[role="status"]')?.textContent).toContain("on its way");
});

it("shows an error when sending fails", async () => {
  vi.mocked(sendBugReport).mockRejectedValue(new Error("boom"));
  await mount();
  await setTextarea("something broke");
  await act(async () => sendButton().click());
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain("boom");
  expect(FEEDBACK_ENDPOINT).toBe("https://vidcord.app/api/feedback");
});
