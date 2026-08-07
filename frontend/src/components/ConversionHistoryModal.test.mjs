import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modalSource = readFileSync(
  new URL("./ConversionHistoryModal.jsx", import.meta.url),
  "utf8",
);
const navbarSource = readFileSync(new URL("./Navbar.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("conversion history opens as a modal below Feedback", () => {
  assert.match(navbarSource, /import ConversionHistoryModal/);
  assert.equal((navbarSource.match(/Lịch sử chuyển đổi/g) || []).length, 2);
  assert.doesNotMatch(navbarSource, /to="\/history"/);
  assert.match(navbarSource, /Góp ý[\s\S]*?Lịch sử chuyển đổi/);
  assert.match(navbarSource, /<ConversionHistoryModal/);
  assert.doesNotMatch(appSource, /ConversionHistoryPage|path="\/history"/);
});

test("history modal shows only the paginated conversion list", () => {
  assert.match(modalSource, /createPortal/);
  assert.match(modalSource, /role="dialog"/);
  assert.match(modalSource, /api\.get\("\/conversion-runs\/me"/);
  assert.match(modalSource, /Danh sách chuyển đổi/);
  assert.match(modalSource, /Chưa có lần chuyển đổi nào/);
  assert.match(modalSource, /Không thể tải lịch sử chuyển đổi/);
  assert.match(modalSource, /statusFilter/);
  assert.match(modalSource, /Trang \{currentPage\} \/ \{totalPages\}/);
  assert.doesNotMatch(modalSource, /StatCard|Tổng lượt|Thống kê chuyển đổi/);
});

test("mobile modal keeps full file names readable", () => {
  assert.match(modalSource, /break-all text-sm font-bold text-slate-900/);
});
