import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  buildGatewayExportPayload,
  gatewayErrorMessage,
} from "./converterOperations.js";

const FRONTEND_ROOT = new URL("../", import.meta.url);
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) return sourceFiles(url);
      return /\.(?:js|jsx|mjs)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)
        ? [url]
        : [];
    }),
  );
  return files.flat();
}

test("export sends only trusted bindings and never client rows", () => {
  const payload = buildGatewayExportPayload({
    runId: "run-123",
    uploadId: "upload-123",
    profileId: "profile-123",
    sessionId: "session-123",
    revision: 2,
    stateHash: "state-xyz",
    acknowledgeWarnings: true,
    idempotencyKey: "export-123",
    rows: [{ untrusted: true }],
  });

  assert.deepEqual(payload, {
    run_id: "run-123",
    upload_id: "upload-123",
    profile_id: "profile-123",
    session_id: "session-123",
    revision: 2,
    state_hash: "state-xyz",
    acknowledge_warnings: true,
    idempotency_key: "export-123",
  });
  assert.equal("rows" in payload, false);
});

test("gateway status errors use the required Vietnamese messages", () => {
  const expected = new Map([
    [401, "Phiên đăng nhập hết hạn"],
    [402, "Không còn lượt chuyển đổi"],
    [403, "Không có quyền dùng hồ sơ này"],
    [409, "Dữ liệu đã thay đổi; tải lại phiên"],
    [413, "File vượt 20 MB"],
    [422, "Còn lỗi MISA cần xử lý"],
    [429, "Quá nhiều yêu cầu; thử lại sau"],
    [500, "Dịch vụ tạm thời lỗi; file chưa bị trừ lượt"],
  ]);

  for (const [status, message] of expected) {
    assert.equal(gatewayErrorMessage({ response: { status } }, "fallback"), message);
  }
});

test("browser source and Vite config contain no direct FastAPI escape hatch", async () => {
  for (const file of await sourceFiles(FRONTEND_ROOT)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /VITE_PYTHON_API_URL|\/python-api/);
  }
  const viteConfig = await readFile(new URL("../../vite.config.js", import.meta.url), "utf8");
  assert.doesNotMatch(viteConfig, /\/python-api|localhost:8000/);
});

test("ConvertPage uses only the canonical gateway conversion run", async () => {
  const source = await readFile(new URL("pages/ConvertPage.jsx", FRONTEND_ROOT), "utf8");
  assert.doesNotMatch(source, /\/conversion-runs|createConversionRunLog|updateConversionRunLog/);
  assert.match(source, /analyzePayload\.runId\s*\|\|\s*analyzePayload\.conversionRunId/);
  assert.doesNotMatch(
    source,
    /conversionIdempotencyKeyRef\.current,\s*analyzePayload\.contextToken/,
  );
  assert.match(source, /analyzePayload\.target_template_id\s*\|\|\s*targetTemplateId/);
});
