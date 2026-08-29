import fs from "node:fs";

const html = fs.readFileSync("site/legacy/index.html", "utf8");
const matches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

if (matches.length === 0) {
  throw new Error("No JSON-LD blocks found in site/legacy/index.html");
}

for (const match of matches) {
  JSON.parse(match[1]);
}

JSON.parse(fs.readFileSync("site/legacy/site.webmanifest", "utf8"));

console.log("site structured data validated");
