import { describe, expect, it } from "vitest";
import { GITHUB_SPONSORS_URL, getDonateLinks } from "../donate";

describe("donate links", () => {
  it("always includes the GitHub Sponsors link first", () => {
    expect(getDonateLinks()[0]).toEqual({ label: "GitHub Sponsors", url: GITHUB_SPONSORS_URL });
  });

  it("hides the secondary slot while its URL is empty", () => {
    expect(getDonateLinks()).toHaveLength(1);
  });
});
