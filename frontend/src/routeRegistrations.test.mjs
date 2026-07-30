import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function assertUnique(values, label) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], `Duplicate ${label}: ${JSON.stringify(duplicates)}`);
  return counts;
}

test("React application routes register exactly once", async () => {
  const source = await readFile(new URL("./App.jsx", import.meta.url), "utf8");
  const paths = [...source.matchAll(/<Route\b[^>]*\bpath=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  const counts = assertUnique(paths, "React route");

  for (const required of [
    "/convert",
    "/student",
    "/pricing",
    "/payment",
    "/admin",
    "/admin/coupons",
  ]) {
    assert.equal(counts.get(required), 1, `${required} must register exactly once`);
  }
  assert.match(source, /lazy\(\(\) => import\("\.\/pages\/StudentAssistantPage"\)\)/);
  assert.match(source, /function StudentAssistantRoute\(\)/);
});

test("converter operation and repair surfaces mount exactly once", async () => {
  const source = await readFile(
    new URL("./pages/ConvertPage.jsx", import.meta.url),
    "utf8",
  );

  for (const component of [
    "MappingProfileV2Card",
    "AnomalyWorkspace",
    "BulkCorrectionDialog",
    "ReconciliationWorkspace",
    "AccountingAssistantDrawer",
    "MisaImportRepairPanel",
  ]) {
    const count = [...source.matchAll(new RegExp(`<${component}\\b`, "g"))].length;
    assert.equal(count, 1, `${component} must mount exactly once`);
  }
});
