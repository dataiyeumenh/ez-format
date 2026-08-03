import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const noticesSource = readFileSync(
  new URL("./NoticesPage.jsx", import.meta.url),
  "utf8",
);
const couponsSource = readFileSync(
  new URL("./CouponsPage.jsx", import.meta.url),
  "utf8",
);

test("admin notices and coupons omit decorative blue eyebrow labels", () => {
  assert.doesNotMatch(noticesSource, />\s*Broadcast\s*</);
  assert.doesNotMatch(couponsSource, /Quản lý ưu đãi/);
});
