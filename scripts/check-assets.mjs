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

for (const file of ["advancedmode.png", "context.png", "file.png", "finder.png", "window.png"]) {
  if (!fs.existsSync(`site/assets/${file}`)) {
    throw new Error(`Missing canonical site/assets/${file}`);
  }
  if (fs.existsSync(`screenshots/${file}`)) {
    throw new Error(
      `screenshots/${file} duplicates site/assets/${file}; use site/assets as canonical`
    );
  }
}

expectSame("public/icon.png", "site/assets/icon.png");

console.log("asset organization ok");
