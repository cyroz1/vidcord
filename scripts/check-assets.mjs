import fs from "node:fs";
import crypto from "node:crypto";

function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function expectSame(left, right) {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  if (leftHash !== rightHash) {
    throw new Error(`${left} and ${right} differ`);
  }
}

for (const file of [
  "advancedmode.png",
  "batchmode.png",
  "context.png",
  "file.png",
  "finder.png",
  "gifmode.png",
  "losslesstrim.png",
  "window.png",
]) {
  if (!fs.existsSync(`site/legacy/assets/${file}`)) {
    throw new Error(`Missing canonical site/legacy/assets/${file}`);
  }
  if (fs.existsSync(`screenshots/${file}`)) {
    throw new Error(
      `screenshots/${file} duplicates site/legacy/assets/${file}; use site/legacy/assets as canonical`
    );
  }
}

expectSame("public/icon.png", "site/legacy/assets/icon.png");
expectSame("public/icon.png", "site/icon.png");

console.log("asset organization ok");
