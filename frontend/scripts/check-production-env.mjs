import { readFile } from "node:fs/promises";

const blockedName = "VITE_PYTHON_API_URL";
const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];

if (process.env[blockedName]) {
  throw new Error(`${blockedName} must not be exposed in a production frontend build.`);
}

for (const file of envFiles) {
  const content = await readFile(file, "utf8").catch(() => "");
  if (new RegExp(`^\\s*${blockedName}\\s*=`, "m").test(content)) {
    throw new Error(`${file} exposes ${blockedName}; remove it before building.`);
  }
}
