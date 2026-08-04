import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trackerSource = readFileSync(
  new URL("./WebsiteVisitTracker.jsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("records at most one website visit per browser session", () => {
  assert.match(trackerSource, /sessionStorage\.getItem/);
  assert.match(trackerSource, /api\s*\.post\("\/analytics\/visit"/);
  assert.match(trackerSource, /sessionStorage\.setItem/);
});

test("mounts the website visit tracker for public and authenticated routes", () => {
  assert.match(appSource, /import WebsiteVisitTracker/);
  assert.match(appSource, /<WebsiteVisitTracker \/>/);
});
