// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import FeedbackDialog from "../components/FeedbackDialog";
import { FEEDBACK_EMAIL, FEEDBACK_ENDPOINT } from "../feedback";
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
  return Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Send report")
  )!;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const REPORT = {
  subject: "Vidcord 7.6.0 bug report",
  body: "user description\n\n---\nApp version: 7.6.0",
  reportPath: "/tmp/vidcord-bug-report-1.txt",
};

it("renders the description box and explains what gets included", async () => {
  await mount();
  expect(container!.querySelector("textarea")).not.toBeNull();
  expect(container!.textContent).toContain("last 100 lines of the app log");
  expect(container!.textContent).toContain("Sends directly to the developer");
});

it("sends the typed description to the endpoint", async () => {
  vi.mocked(collectBugReport).mockResolvedValue(REPORT);
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  await mount();
  await setTextarea("export blew up");
  await act(async () => sendButton().click());

  expect(collectBugReport).toHaveBeenCalledWith("export blew up");
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(FEEDBACK_ENDPOINT);
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("X-Vidcord-Feedback")).toBeTruthy();
  expect(JSON.parse(init.body as string)).toEqual({ subject: REPORT.subject, body: REPORT.body });
  expect(container!.textContent).toContain("Report sent");
  expect(container!.textContent).toContain(REPORT.reportPath);
});

it("passes null when the description is left empty", async () => {
  vi.mocked(collectBugReport).mockResolvedValue(REPORT);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
  await mount();
  await act(async () => sendButton().click());
  expect(collectBugReport).toHaveBeenCalledWith(null);
});

it("falls back to the mail app when the endpoint fails", async () => {
  vi.mocked(collectBugReport).mockResolvedValue(REPORT);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("nope", { status: 503 }))
  );
  await mount();
  await act(async () => sendButton().click());

  expect(container!.querySelector('[role="alert"]')?.textContent).toContain("503");
  const fallback = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Open in mail app instead")
  )!;
  await act(async () => fallback.click());

  const mailto = vi.mocked(openUrl).mock.calls[0][0] as string;
  expect(mailto.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`)).toBe(true);
  expect(mailto).toContain(encodeURIComponent(REPORT.subject));
  expect(mailto).toContain(encodeURIComponent(REPORT.body));
  expect(container!.textContent).toContain(REPORT.reportPath);
});
