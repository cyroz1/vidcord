import { describe, expect, it, vi } from "vitest";
import { triggerSystemNotification } from "../hooks/useToasts";

describe("triggerSystemNotification", () => {
  it("sends the exact in-app banner title and message", async () => {
    const send = vi.fn(async () => true);

    await triggerSystemNotification(
      'Compression "Complete"',
      "Saved clip <one>.\nReady to share.",
      send
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      'Compression "Complete"',
      "Saved clip <one>.\nReady to share."
    );
  });

  it("preserves banner order when notifications are added together", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const send = vi.fn(async (title: string) => {
      started.push(title);
      if (title === "First") {
        await firstPending;
      }
      return true;
    });

    const first = triggerSystemNotification("First", "First body", send);
    const second = triggerSystemNotification("Second", "Second body", send);
    await Promise.resolve();

    expect(started).toEqual(["First"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(started).toEqual(["First", "Second"]);
  });

  it("continues delivering later banners after a platform failure", async () => {
    const send = vi
      .fn<(title: string, body: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("notifications disabled"))
      .mockResolvedValueOnce(true);

    await expect(triggerSystemNotification("Failed", "First body", send)).resolves.toBeUndefined();
    await expect(
      triggerSystemNotification("Recovered", "Second body", send)
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenNthCalledWith(1, "Failed", "First body");
    expect(send).toHaveBeenNthCalledWith(2, "Recovered", "Second body");
  });
});
