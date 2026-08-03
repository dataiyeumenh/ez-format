import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const navbarSource = readFileSync(new URL("./Navbar.jsx", import.meta.url), "utf8");
const noticeBellSource = readFileSync(
  new URL("./NoticeBell.jsx", import.meta.url),
  "utf8",
);

test("authenticated desktop and mobile navbar render the notice bell", () => {
  const uses = navbarSource.match(/<NoticeBell/g) || [];
  assert.equal(uses.length, 2);
  assert.match(navbarSource, /<NoticeBell mobile \/>/);
});

test("notice bell loads notices and exposes all user-visible states", () => {
  assert.match(noticeBellSource, /api\.get\("\/notices"/);
  assert.match(noticeBellSource, /api\.post\("\/notices\/read"/);
  assert.match(noticeBellSource, /unreadCount/);
  assert.match(noticeBellSource, /thông báo chưa đọc/);
  assert.match(noticeBellSource, /Đang tải thông báo/);
  assert.match(noticeBellSource, /Chưa có thông báo/);
  assert.match(noticeBellSource, /Thử lại/);
});

test("notice bell stays inside mobile viewport and supports keyboard dismissal", () => {
  assert.match(noticeBellSource, /fixed inset-x-4 top-16/);
  assert.match(noticeBellSource, /event\.key === "Escape"/);
  assert.match(noticeBellSource, /tabIndex=\{-1\}/);
  assert.match(noticeBellSource, /buttonRef\.current\?\.focus\(\)/);
});

test("mobile account actions remain mounted until their click handlers run", () => {
  assert.match(navbarSource, /const mobileMenuRef = useRef\(null\)/);
  assert.match(navbarSource, /ref=\{mobileMenuRef\}/);
  assert.match(
    navbarSource,
    /menuRef\.current\?\.contains\(event\.target\)[\s\S]*mobileMenuRef\.current\?\.contains\(event\.target\)/,
  );
});
