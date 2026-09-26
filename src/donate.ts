// Donation links shared by the desktop app footer and the website.
// Update the URLs here; both surfaces read from this module.
//
// Primary: GitHub Sponsors for cyroz1. Enable Sponsors on the GitHub account
// to make this link live; until then it 404s.
export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/cyroz1";

// Optional second slot (e.g. Ko-fi, Buy Me a Coffee). Leave the URL empty and
// it stays hidden everywhere.
export const SECONDARY_DONATE_LABEL = "Ko-fi";
export const SECONDARY_DONATE_URL = "";

export interface DonateLink {
  label: string;
  url: string;
}

export function getDonateLinks(): DonateLink[] {
  const links: DonateLink[] = [{ label: "GitHub Sponsors", url: GITHUB_SPONSORS_URL }];
  if (SECONDARY_DONATE_URL.trim() !== "") {
    links.push({ label: SECONDARY_DONATE_LABEL, url: SECONDARY_DONATE_URL });
  }
  return links;
}
