import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

for (const test of ["run-web.mjs", "run-desktop.mjs"]) {
  const result = spawnSync(process.execPath, [path.join(repository, "scripts/e2e", test)], {
    cwd: repository,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
