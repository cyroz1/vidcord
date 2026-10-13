import { describe, expect, it } from "vitest";
import { buildMailto, FEEDBACK_EMAIL, FEEDBACK_ENDPOINT } from "../feedback";

describe("feedback helpers", () => {
  it("points at the worker endpoint", () => {
    expect(FEEDBACK_ENDPOINT).toBe("https://vidcord.app/api/feedback");
  });

  it("builds an encoded mailto fallback", () => {
    const url = buildMailto({
      subject: "Vidcord 7.6.0 bug report",
      body: "line one\nline two & more",
      reportPath: "/tmp/x.txt",
    });
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`)).toBe(true);
    expect(url).toContain(encodeURIComponent("Vidcord 7.6.0 bug report"));
    expect(url).toContain(encodeURIComponent("line one\nline two & more"));
  });
});
