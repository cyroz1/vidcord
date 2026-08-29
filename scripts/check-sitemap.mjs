import fs from "node:fs";

const path = "site/sitemap.xml";
const xml = fs.readFileSync(path, "utf8").trim();
const documentMatch = xml.match(
  /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">([\s\S]*)<\/urlset>$/
);

if (!documentMatch) {
  throw new Error(`${path} must be a UTF-8 sitemap urlset with the standard namespace`);
}

const entryPattern =
  /<url>\s*<loc>(https:\/\/vidcord\.app\/[^<>&"]*)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<changefreq>(always|hourly|daily|weekly|monthly|yearly|never)<\/changefreq>\s*<priority>(0(?:\.\d)?|1(?:\.0)?)<\/priority>\s*<\/url>/g;
const body = documentMatch[1];
const entries = [...body.matchAll(entryPattern)].map((match) => ({
  loc: match[1],
  lastmod: match[2],
}));

if (body.replace(entryPattern, "").trim()) {
  throw new Error(`${path} contains malformed or unsupported XML content`);
}

const expectedLocations = [
  "https://vidcord.app/",
  "https://vidcord.app/legacy/",
  "https://vidcord.app/llms.txt",
  "https://vidcord.app/llms-full.txt",
];
const locations = entries.map(({ loc }) => loc);
const uniqueLocations = new Set(locations);
const missingLocations = expectedLocations.filter((loc) => !uniqueLocations.has(loc));

if (uniqueLocations.size !== locations.length) {
  throw new Error(`${path} contains duplicate locations`);
}

if (missingLocations.length > 0) {
  throw new Error(`${path} is missing required locations: ${missingLocations.join(", ")}`);
}

for (const { loc, lastmod } of entries) {
  const date = new Date(`${lastmod}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== lastmod) {
    throw new Error(`${path} has invalid lastmod ${lastmod} for ${loc}`);
  }
}

console.log(`sitemap validated: ${entries.length} URLs`);
