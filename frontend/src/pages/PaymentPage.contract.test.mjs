import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const paymentPageUrl = new URL("./PaymentPage.jsx", import.meta.url);

test("payment UI previews coupons and sends the applied code at checkout", async () => {
  const source = await readFile(paymentPageUrl, "utf8");

  assert.match(source, /api\.post\("\/payments\/preview-coupon"/);
  assert.match(source, /couponCode: code/);
  assert.match(source, /api\.post\("\/payments\/create"/);
  assert.match(source, /couponCode: appliedCoupon\?\.code \|\| undefined/);
  assert.match(source, /placeholder="Nhập mã coupon"/);
});
