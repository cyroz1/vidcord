import fs from "node:fs";

if (fs.existsSync("site/legacy")) {
  throw new Error("site/legacy must not exist; the root site is the only public website route");
}

const html = fs.readFileSync("site/index.html", "utf8");
const matches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

if (matches.length === 0) {
  throw new Error("No JSON-LD blocks found in site/index.html");
}

for (const match of matches) {
  JSON.parse(match[1]);
}

JSON.parse(fs.readFileSync("site/site.webmanifest", "utf8"));

console.log("site structured data validated");
