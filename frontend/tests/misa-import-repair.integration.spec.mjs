import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "../../backend/node_modules/xlsx/xlsx.mjs";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(frontendRoot, "..");
let appOrigin;
const syntheticOrigin = "synthetic_ezformat";
const appUser = {
  id: "task9-user-a",
  email: "task9-a@example.test",
  name: "Task 9 A",
  role: "user",
  plan: { code: "pro" },
};
const otherUser = {
  id: "task9-user-b",
  email: "task9-b@example.test",
  name: "Task 9 B",
  role: "user",
  plan: { code: "pro" },
};

const fixtures = [
  { id: "purchase-unique", name: "purchase-unique.xlsx", bookType: "xlsx", flow: "unique", template: "misa_purchase_domestic", documentNumber: "PO-001", groups: ["purchase-group-1"] },
  { id: "sales-unique", name: "sales-unique.xls", bookType: "biff8", flow: "unique", template: "bsn_sales", documentNumber: "SO-001", groups: ["sales-group-1"] },
  { id: "duplicate-number", name: "duplicate-number.xlsx", bookType: "xlsx", flow: "ambiguous", template: "bsn_sales", documentNumber: "SO-DUP", groups: ["duplicate-group-1", "duplicate-group-2"] },
  { id: "multiline-partial", name: "multiline-partial.xlsx", bookType: "xlsx", flow: "multiline", template: "bsn_sales", documentNumber: "SO-MULTI", groups: ["multiline-group-1"], detailRows: 2 },
  { id: "unknown-status", name: "unknown-status.xlsx", bookType: "xlsx", flow: "unknown", template: "bsn_sales", documentNumber: "SO-UNKNOWN", groups: ["unknown-group-1"] },
  { id: "hidden-formula-warning", name: "hidden-formula-warning.xlsx", bookType: "xlsx", flow: "warnings", template: "bsn_sales", documentNumber: "SO-WARN", groups: ["warning-group-1"], warnings: ["hidden row", "formula"] },
  { id: "expired-artifact", name: "expired-artifact.xlsx", bookType: "xlsx", flow: "expired", template: "bsn_sales", documentNumber: "SO-EXPIRED", groups: ["expired-group-1"] },
];

const workbookContracts = {
  biff8: { extension: ".xls", mimeType: "application/vnd.ms-excel", signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  xlsx: { extension: ".xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
};

function workbookContract(fixture) {
  const contract = workbookContracts[fixture.bookType];
  assert.ok(contract, `unsupported workbook bookType ${fixture.bookType}`);
  assert.equal(path.extname(fixture.name), contract.extension, `${fixture.name} extension must match ${fixture.bookType}`);
  return contract;
}

function fixtureMetadata(fixture) {
  return {
    fixture_id: fixture.id,
    fixture_origin: syntheticOrigin,
    source: "runtime-only synthetic workbook; not verified MISA",
    verified_misa: false,
  };
}

function workbookBytes(fixture, retry = false) {
  const meta = fixtureMetadata(fixture);
  const rows = [
    ["fixture_origin", meta.fixture_origin],
    ["verified_misa", meta.verified_misa],
    ["source", meta.source],
    [],
    ["Số chứng từ", "Thông báo kỹ thuật", "Mã hàng", "Thành tiền"],
    [fixture.documentNumber, "Mã hàng không tồn tại", "HH-001", 100],
  ];
  if (fixture.detailRows === 2) rows.push([fixture.documentNumber, "Dòng chi tiết lỗi", "HH-002", 200]);
  if (retry) {
    rows.push([], ["retry_template", fixture.template], ["document_group_id", fixture.groups[0]], ["whole_document_group", true]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (fixture.flow === "warnings") {
    sheet["!rows"] = [];
    sheet["!rows"][5] = { hidden: true };
    sheet.C6 = { t: "n", f: "D6*2", v: 200 };
  }
  const manifest = XLSX.utils.aoa_to_sheet([
    ["fixture_id", meta.fixture_id],
    ["manifest_immutable", true],
    ["fixture_origin", meta.fixture_origin],
    ["verified_misa", meta.verified_misa],
    ["template_id", fixture.template],
    ["provenance", "1:1;1:n;n:1"],
    ["document_group_ids", fixture.groups.join(",")],
    ["credit_charge_count", 0],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, retry ? "Retry" : "ImportResult");
  XLSX.utils.book_append_sheet(book, manifest, "Manifest");
  return Buffer.from(XLSX.write(book, { bookType: fixture.bookType, type: "buffer" }));
}

function assertWorkbook(buffer, fixture, { retry = false, filename = fixture.name, mimeType } = {}) {
  const contract = workbookContract(fixture);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 100, `${fixture.name} must be a real workbook`);
  assert.equal(buffer.subarray(0, contract.signature.length).compare(contract.signature), 0, `${fixture.name} byte signature must match ${fixture.bookType}`);
  assert.equal(path.extname(filename), contract.extension, `${filename} extension must match workbook bytes`);
  if (mimeType) assert.equal(mimeType.split(";")[0], contract.mimeType, `${filename} MIME must match workbook bytes`);
  const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellNF: true, cellStyles: true });
  assert.ok(workbook.SheetNames.includes(retry ? "Retry" : "ImportResult"));
  assert.ok(workbook.SheetNames.includes("Manifest"));
  const manifest = XLSX.utils.sheet_to_json(workbook.Sheets.Manifest, { header: 1, defval: null });
  const values = new Map(manifest.filter((row) => row.length >= 2).map(([key, value]) => [key, value]));
  assert.equal(values.get("fixture_id"), fixture.id);
  assert.equal(values.get("fixture_origin"), syntheticOrigin);
  assert.equal(values.get("verified_misa"), false);
  assert.equal(values.get("manifest_immutable"), true);
  assert.equal(values.get("template_id"), fixture.template);
  assert.equal(values.get("provenance"), "1:1;1:n;n:1");
  assert.equal(values.get("credit_charge_count"), 0);
  if (fixture.detailRows) {
    const output = XLSX.utils.sheet_to_json(workbook.Sheets[retry ? "Retry" : "ImportResult"], { header: 1, defval: null });
    assert.ok(output.filter((row) => row[0] === fixture.documentNumber).length >= fixture.detailRows);
  }
  if (fixture.flow === "warnings") {
    const sheet = workbook.Sheets[retry ? "Retry" : "ImportResult"];
    assert.equal(sheet["!rows"]?.[5]?.hidden, true);
    assert.equal(sheet.C6?.f, "D6*2");
  }
  if (retry) {
    assert.equal(values.get("manifest_immutable"), true);
    assert.ok(String(values.get("document_group_ids")).includes(fixture.groups[0]));
  }
  return workbook;
}

function workbookFixtureId(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Manifest, { header: 1, defval: null });
  const fixtureId = rows.find((row) => row[0] === "fixture_id")?.[1];
  return fixtureId;
}

async function extractMultipartFile(request) {
  const contentType = request.headers()["content-type"] || "";
  const boundary = contentType.match(/boundary=([^;]+)/i)?.[1];
  assert.ok(boundary, `missing multipart boundary: ${contentType}`);
  const body = request.postDataBuffer();
  assert.ok(body, "upload must contain multipart bytes");
  const marker = Buffer.from(`filename="`);
  const filenameStart = body.indexOf(marker);
  assert.ok(filenameStart >= 0, "multipart upload must contain a filename");
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), filenameStart);
  const boundaryBytes = Buffer.from(`\r\n--${boundary}`);
  const fileEnd = body.indexOf(boundaryBytes, headerEnd + 4);
  assert.ok(headerEnd > filenameStart && fileEnd > headerEnd, "multipart file part is malformed");
  return body.subarray(headerEnd + 4, fileEnd);
}

function assertMultipartField(request, name, expectedValue) {
  const body = request.postDataBuffer()?.toString("utf8") || "";
  assert.ok(body.includes(`name="${name}"`), `multipart upload must contain ${name}`);
  assert.ok(
    body.includes(`\r\n\r\n${expectedValue}\r\n`),
    `${name} must preserve its production binding`,
  );
}

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function repairState(fixture, stage) {
  const ambiguous = fixture.flow === "ambiguous";
  const unknown = fixture.flow === "unknown";
  const matched = ["matched", "status", "resolved", "resolved_unknown"].includes(stage);
  const statusFailed = ["status", "resolved"].includes(stage);
  const resolved = ["resolved", "resolved_unknown"].includes(stage);
  const groupStatuses = fixture.groups.map((documentGroupId) => ({
    documentGroupId,
    status: statusFailed ? "failed" : "unknown",
    userConfirmed: statusFailed,
    evidence: {
      documentNumber: fixture.documentNumber,
      lineCount: fixture.detailRows || 1,
      outputRowNumbers: [2 + fixture.groups.indexOf(documentGroupId)],
    },
  }));
  const issues = fixture.groups.map((documentGroupId, index) => ({
    id: `${fixture.id}-issue-${index + 1}`,
    artifactRowNumber: index + 2,
    technicalMessage: index ? "Dòng chi tiết lỗi" : "Mã hàng không tồn tại",
    matchStatus: matched ? "confirmed" : ambiguous ? "ambiguous" : "suggested",
    candidates: fixture.groups.map((group) => ({
      documentGroupId: group,
      method: "exact_business_key",
      evidence: JSON.stringify({ matched_fields: ["document_number"], output_row_number: index + 2 }),
    })),
    confirmedDocumentGroupId: matched ? fixture.groups[0] : undefined,
    normalizedLocator: { sourceRowNumber: index + 10, documentNumber: fixture.documentNumber },
    resolution: resolved
      ? { status: "resolved", patch: { field: "Mã hàng", value: "HH-FIXED" } }
      : { status: "unresolved" },
    importStatus: statusFailed ? "failed" : "unknown",
  }));
  return {
    repairId: `repair-${fixture.id}`,
    status: resolved ? (stage === "resolved_unknown" ? "retry_blocked" : "retry_ready") : "needs_match_review",
    version: stage === "schema" ? 2 : 3,
    issues,
    documentGroupStatuses: groupStatuses,
    summary: {
      unknownDocumentGroups: stage === "resolved_unknown" || !resolved ? 1 : 0,
      unresolvedIssues: resolved ? 0 : 1,
      unmatchedIssues: resolved ? 0 : 1,
      ambiguousIssues: ambiguous ? 1 : 0,
    },
    readiness: {
      version: 3,
      hash: "a".repeat(64),
      summary: { fatal: 0, blocker: 0, warning: fixture.warnings?.length ? 1 : 0, info: 0 },
      issues: fixture.warnings?.length
        ? [{ severity: "warning", code: "review_workbook", message: "Rà soát hidden row và formula", field: "Mã hàng", rowNumber: 2 }]
        : [],
    },
    retryGate: { enabled: resolved && !ambiguous && !unknown },
  };
}

function installApiRoutes(page, actor, options = {}) {
  const state = {
    fixture: null,
    stage: "uploaded",
    requests: [],
    credits: 1,
    mapping: null,
    conversionRun: null,
    conversionRunSequence: 0,
  };
  page.on("request", (request) => {
    if (request.url().includes("/api/")) state.requests.push(request);
  });
  page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, "");
    const auth = request.headers().authorization;
    assert.equal(auth, `Bearer task9-${actor.id}`);

    if (pathname === "/converter/capabilities" || pathname === "/converter/health") {
      return json(route, {
        ai: { gateway: "offline", model: "offline", mapping: "not_run" },
        capabilities: {},
        misa_import_repair: { enabled: true, phase: 1, adapter: "manual_excel_v1" },
      });
    }
    if (pathname === "/converter/templates") {
      return json(route, { items: [
        { id: "bsn_sales", label: "BSN - Form import bán hàng", headers: ["Số chứng từ (*)", "Ngày chứng từ (*)", "Thành tiền"] },
        { id: "misa_purchase_domestic", label: "Mua hàng trong nước - MISA", headers: ["Số chứng từ (*)", "Ngày chứng từ (*)", "Thành tiền"] },
      ] });
    }
    if (pathname === "/accounting-workspaces") return json(route, { items: [{ id: actor.id === appUser.id ? "workspace-a" : "workspace-b", name: `Workspace ${actor.id}` }] });
    if (pathname.endsWith("/master-data")) return json(route, { snapshots: [] });
    if (pathname === "/conversion-runs" && request.method() === "POST") {
      const payload = request.postDataJSON();
      assert.ok(payload.fileName, "conversion run must identify the uploaded file");
      state.conversionRunSequence += 1;
      state.conversionRun = {
        id: `run-${actor.id}-${state.conversionRunSequence}`,
        operationSessionId: `operation-session-${actor.id}-${state.conversionRunSequence}`,
        converterUploadId: `converter-upload-${actor.id}-${state.conversionRunSequence}`,
      };
      return json(route, { success: true, run: state.conversionRun }, 201);
    }
    if (pathname.endsWith("/conversion-context")) {
      return json(route, {
        contextToken: `workspace-context-${actor.id}`,
        conversionRunId: state.conversionRun?.id,
        operationSessionId: state.conversionRun?.operationSessionId,
        uploadId: state.conversionRun?.converterUploadId,
      });
    }
    if (pathname === "/converter/context") {
      return json(route, {
        contextToken: `personal-context-${actor.id}`,
        conversionRunId: state.conversionRun?.id,
        operationSessionId: state.conversionRun?.operationSessionId,
        uploadId: state.conversionRun?.converterUploadId,
      });
    }

    if (pathname === "/converter/uploads/analyze" && request.method() === "POST") {
      assert.ok(state.conversionRun, "analyze requires a preallocated conversion run");
      assertMultipartField(request, "conversion_run_id", state.conversionRun.id);
      assertMultipartField(request, "operation_session_id", state.conversionRun.operationSessionId);
      assertMultipartField(request, "upload_id", state.conversionRun.converterUploadId);
      const uploaded = await extractMultipartFile(request);
      const markerFixture = fixtures.find((item) => workbookFixtureId(uploaded) === item.id);
      assert.ok(markerFixture, "analyze upload must be a valid synthetic workbook");
      assertWorkbook(uploaded, markerFixture);
      if (!state.fixture) state.fixture = markerFixture;
      return json(route, {
        upload_id: state.conversionRun.converterUploadId,
        runId: state.conversionRun.id,
        operation_session_id: state.conversionRun.operationSessionId,
        conversion_run_id: state.conversionRun.id,
        contextToken: `context-${actor.id}`,
        target_template_id: markerFixture.template === "misa_purchase_domestic" ? "misa_purchase_domestic" : "bsn_sales",
        detected: { sheet_name: "ImportResult", headers: ["Số chứng từ", "Thông báo kỹ thuật", "Mã hàng", "Thành tiền"], row_count: markerFixture.detailRows || 1 },
        mapping_suggestion: { mapping: { "Số chứng từ": "Số chứng từ (*)", "Thành tiền": "Thành tiền" }, warnings: markerFixture.warnings || [], source: "schema", confidence: 0.99 },
        ai: { gateway: "offline", model: "offline", mapping: "not_run" },
      });
    }
    if (pathname === "/converter/mappings/preview") return json(route, { headers: ["Số chứng từ (*)", "Ngày chứng từ (*)", "Thành tiền"], rows: [["SO-001", "2026-07-29", 100]], issues: [] });
    if (pathname === "/converter/mappings/readiness") return json(route, { summary: { blocker: 0, warning: 0, fatal: 0 }, issues: [] });
    if (pathname === "/converter/mappings/confirm") {
      return json(route, { profile_id: "profile-task9", session: { session_id: `session-${actor.id}`, active_revision: 1, state_hash: "state-hash-task9" } });
    }
    if (pathname.match(/^\/converter\/runs\/[^/]+\/context$/)) return json(route, { contextToken: `export-context-${actor.id}` });
    if (pathname === "/converter/conversions/export") {
      state.credits = 1;
      const fixture = state.fixture || fixtures[1];
      const contract = workbookContract(fixture);
      return route.fulfill({ status: 200, contentType: contract.mimeType, headers: { "access-control-expose-headers": "Content-Disposition", "content-disposition": `attachment; filename="original-template${contract.extension}"` }, body: workbookBytes(fixture) });
    }

    if (pathname === "/converter/import-repairs" && request.method() === "POST") {
      const uploaded = await extractMultipartFile(request);
      const markerFixture = fixtures.find((item) => workbookFixtureId(uploaded) === item.id);
      assert.ok(markerFixture, "repair upload must be a valid synthetic workbook");
      assertWorkbook(uploaded, markerFixture);
      state.fixture = markerFixture;
      if (options.expire || markerFixture.flow === "expired") return json(route, { error: "Phiên sửa lỗi đã hết hạn. Tải lại file lỗi MISA để bắt đầu một phiên mới." }, 410);
      if (options.converterOffline) return json(route, { error: "Converter offline" }, 503);
      state.stage = "uploaded";
      return json(route, {
        repairId: `repair-${markerFixture.id}`,
        status: "needs_schema_mapping",
        version: 1,
        inspection: null,
        workbook: { sheetName: "ImportResult", headerRow: 5, headers: ["Số chứng từ", "Thông báo kỹ thuật", "Mã hàng", "Thành tiền"], status: "needs_schema_mapping" },
      });
    }
    const repairMatch = pathname.match(/^\/converter\/import-repairs\/([^/]+)/);
    if (repairMatch) {
      const repairId = repairMatch[1];
      const repairPath = pathname.slice(`/converter/import-repairs/${repairId}`.length);
      const fixture = fixtures.find((item) => `repair-${item.id}` === repairId) || state.fixture;
      if (actor.id === otherUser.id && repairId === "repair-cross-user") return json(route, { error: "Không có quyền truy cập phiên sửa lỗi của người dùng khác" }, 403);
      if (!fixture) return json(route, { error: "Repair not found" }, 404);
      if (options.expireRead) return json(route, { error: "Phiên sửa lỗi đã hết hạn. Tải lại file lỗi MISA để bắt đầu một phiên mới." }, 410);
      if (request.method() === "GET" && repairPath === "") {
        const next = repairState(fixture, state.stage);
        return json(route, {
          session: next,
          issues: next.issues,
          documentGroups: next.documentGroupStatuses,
          nextCursor: null,
          nextGroupCursor: null,
          readiness: next.readiness,
          retryGate: next.retryGate,
        });
      }
      if (repairPath === "/schema" && request.method() === "POST") {
        const payload = request.postDataJSON();
        assert.equal(payload.columns.technical_message, "Thông báo kỹ thuật");
        assert.equal(payload.columns.document_number, "Số chứng từ");
        state.mapping = payload.columns;
        state.stage = "schema";
        return json(route, { repairId, status: "needs_match_review", version: 2, summary: {}, issues: [] });
      }
      if (repairPath === "/human-confirmations" && request.method() === "POST") {
        const payload = request.postDataJSON();
        if (payload.action === "retry_export") {
          assert.equal(payload.payload.readiness_hash, "a".repeat(64));
        }
        return json(route, { confirmationToken: `confirm-${actor.id}` });
      }
      const matchEndpoint = repairPath.match(/^\/issues\/([^/]+)\/confirm-match$/);
      if (matchEndpoint && request.method() === "POST") { state.stage = "matched"; return json(route, { ok: true }); }
      const statusEndpoint = repairPath.match(/^\/document-groups\/([^/]+)\/import-status$/);
      if (statusEndpoint && request.method() === "POST") {
        assert.equal(request.postDataJSON().confirmation, "entire_document_not_imported");
        state.stage = "status";
        return json(route, { ok: true });
      }
      const resolveEndpoint = repairPath.match(/^\/issues\/([^/]+)\/resolve$/);
      if (resolveEndpoint && request.method() === "POST") { state.stage = fixture.flow === "unknown" ? "resolved_unknown" : "resolved"; return json(route, { ok: true }); }
      if (repairPath === "/retry-batches" && request.method() === "POST") {
        const payload = request.postDataJSON();
        assert.deepEqual(payload.document_group_ids, [fixture.groups[0]]);
        assert.equal(payload.acknowledge_warnings, fixture.flow === "warnings");
        assert.equal(payload.readiness_hash, "a".repeat(64));
        assert.equal(payload.credits_charged, undefined);
        return json(route, { batchId: `batch-${fixture.id}`, status: "completed", whole_document_groups: true, credits_charged: 0, manifest: { immutable: true, provenance: ["1:1", "1:n", "n:1"], template_id: fixture.template, document_group_ids: fixture.groups } });
      }
      const downloadEndpoint = repairPath.match(/^\/retry-batches\/([^/]+)\/download$/);
      if (downloadEndpoint && request.method() === "GET") {
        const contract = workbookContract(fixture);
        return route.fulfill({ status: 200, contentType: contract.mimeType, headers: { "access-control-expose-headers": "Content-Disposition", "content-disposition": `attachment; filename="${fixture.id}-retry${contract.extension}"` }, body: workbookBytes(fixture, true) });
      }
    }
    return json(route, { error: `Unexpected deterministic API request ${request.method()} ${pathname}` }, 500);
  });
  return state;
}

async function seedAuth(context, actor) {
  await context.addInitScript(({ user }) => {
    localStorage.setItem("token", `task9-${user.id}`);
    localStorage.setItem("user", JSON.stringify(user));
    localStorage.setItem("ezformat_accounting_workspace_id", user.id === "task9-user-a" ? "workspace-a" : "workspace-b");
  }, { user: actor });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function waitForProcessExit(processHandle, timeoutMs = 10_000) {
  if (processHandle.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Vite process ${processHandle.pid} did not exit`)), timeoutMs)),
  ]);
}

async function stopVite(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
    await new Promise((resolve, reject) => {
      taskkill.once("error", reject);
      taskkill.once("exit", resolve);
    });
  } else {
    processHandle.kill("SIGTERM");
  }
  await waitForProcessExit(processHandle);
}

async function startVite() {
  const port = await reservePort();
  appOrigin = `http://127.0.0.1:${port}`;
  const viteEntry = path.join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
  const processHandle = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: frontendRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let output = "";
  let spawnError;
  processHandle.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  processHandle.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  processHandle.once("error", (error) => { spawnError = error; });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (spawnError) throw spawnError;
    if (processHandle.exitCode !== null) throw new Error(`Owned Vite process exited with ${processHandle.exitCode}: ${output}`);
    try {
      const [indexResponse, entryResponse] = await Promise.all([
        fetch(`${appOrigin}/`),
        fetch(`${appOrigin}/src/main.jsx`),
      ]);
      const [indexHtml, entrySource] = await Promise.all([indexResponse.text(), entryResponse.text()]);
      const isExpectedApp = indexResponse.ok && entryResponse.ok
        && indexHtml.includes('id="root"') && indexHtml.includes('/src/main.jsx')
        && entrySource.includes("ReactDOM.createRoot") && entrySource.includes("/src/App.jsx");
      if (isExpectedApp && processHandle.exitCode === null) return processHandle;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stopVite(processHandle);
  throw new Error(`Owned Vite app failed identity/readiness checks at ${appOrigin}: ${output}`);
}

let viteProcess;
test.beforeAll(async () => { viteProcess = await startVite(); });
test.afterAll(async () => { await stopVite(viteProcess); });

async function openConvertedRepair(page, actor, fixture, options = {}) {
  const state = installApiRoutes(page, actor, options);
  await page.goto(`${appOrigin}/convert`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Chuyển đổi Excel/ }).first()).toBeVisible();
  const original = workbookBytes(fixture);
  await page.locator('input[type="file"]').first().setInputFiles({ name: fixture.name, mimeType: fixture.bookType === "biff8" ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: original });
  await page.getByRole("button", { name: "Phân tích & gợi ý ghép cột", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ghép cột Excel → Chuẩn định dạng kế toán" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Xem trước", exact: true }).first().click();
  await page.getByRole("button", { name: "Kiểm tra lỗi", exact: true }).first().click();
  const originalExportButton = page.getByRole("button", { name: "Tải file MISA", exact: true }).first();
  await expect(originalExportButton).toBeEnabled({ timeout: 20_000 });
  const originalDownload = page.waitForEvent("download");
  const originalResponse = page.waitForResponse((response) => response.url().endsWith("/api/converter/conversions/export"));
  await originalExportButton.click();
  const download = await originalDownload;
  const response = await originalResponse;
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  assertWorkbook(await readFile(downloadPath), fixture, { filename: download.suggestedFilename(), mimeType: response.headers()["content-type"] });
  await expect(page.getByText("Đã xuất file kết quả", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tải file lỗi lên" }).click();
  return { state, original };
}

async function uploadRepairFile(page, fixture) {
  await page.locator("#import-result-file").setInputFiles({ name: fixture.name, mimeType: workbookContract(fixture).mimeType, buffer: workbookBytes(fixture) });
  await page.getByRole("button", { name: "Phân tích file lỗi" }).click();
}

async function completeRepair(page, fixture) {
  await uploadRepairFile(page, fixture);
  await expect(page.getByText("Ghép cột thông báo kỹ thuật", { exact: true })).toBeVisible();
  await page.getByLabel("Cột thông báo MISA").selectOption({ label: "Thông báo kỹ thuật" });
  await page.getByLabel("Cột số chứng từ").selectOption({ label: "Số chứng từ" });
  await page.getByRole("button", { name: "Xác nhận ghép cột" }).click();
  const issueTable = page.locator("table");
  await expect(issueTable.getByText("Mã hàng không tồn tại").first()).toBeVisible();
  await issueTable.getByRole("button", { name: "Xác nhận ghép" }).click();
  await page.locator("select").filter({ hasText: "Thất bại" }).first().selectOption("failed");
  await page.getByLabel("Toàn bộ chứng từ này chưa được MISA nhập").check();
  await page.getByRole("button", { name: "Xác nhận chứng từ thất bại" }).click();
  await issueTable.getByLabel(/Giá trị sửa cho dòng/).fill("HH-FIXED");
  await issueTable.getByLabel(/Trường cần sửa cho dòng/).fill("Mã hàng");
  await issueTable.getByRole("button", { name: "Áp dụng cách sửa" }).click();
  await page.getByRole("button", { name: /5 Xuất lại chứng từ thất bại/ }).click();
  if (fixture.flow === "warnings") await page.getByLabel(/Tôi đã rà soát/).check();
  await expect(page.getByRole("button", { name: "Tạo file xuất lại" })).toBeEnabled();
  await page.getByRole("button", { name: "Tạo file xuất lại" }).click();
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().includes("/retry-batches/") && response.url().endsWith("/download"));
  await page.getByRole("button", { name: "Tải file xuất lại" }).click();
  const download = await downloadPromise;
  const response = await responsePromise;
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  assertWorkbook(await readFile(downloadPath), fixture, { retry: true, filename: download.suggestedFilename(), mimeType: response.headers()["content-type"] });
  return download;
}

async function keyboardActivate(page, locator, key = "Enter") {
  await locator.focus();
  await expect(locator).toBeFocused();
  await page.keyboard.press(key);
}

async function keyboardChooseFile(page, button, file) {
  const chooserPromise = page.waitForEvent("filechooser");
  await keyboardActivate(page, button);
  await (await chooserPromise).setFiles(file);
}

async function assertNoHorizontalOverflow(page) {
  const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.clientWidth).toBe(375);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}

test("Task 9 fixtures are runtime-generated real XLS/XLSX workbooks with explicit synthetic provenance", () => {
  assert.equal(fixtures.length, 7);
  for (const fixture of fixtures) assertWorkbook(workbookBytes(fixture), fixture);
  assert.notDeepEqual(workbookBytes(fixtures[0]), Buffer.from("synthetic workbook"));
});

test("production app completes purchase, sales, multiline, and warning repair journeys", async ({ browser }) => {
  for (const fixture of fixtures.filter((item) => ["purchase-unique", "sales-unique", "multiline", "warnings"].includes(item.flow))) {
    const context = await browser.newContext();
    await seedAuth(context, appUser);
    const page = await context.newPage();
    const { state } = await openConvertedRepair(page, appUser, fixture);
    await completeRepair(page, fixture);
    const uploaded = state.requests.find((request) => request.url().endsWith("/api/converter/import-repairs"));
    expect(uploaded).toBeTruthy();
    expect(state.mapping).toEqual({ technical_message: "Thông báo kỹ thuật", document_number: "Số chứng từ" });
    expect(state.credits).toBe(1);
    await expect(
      page.getByText(/AI tạm thời không hoạt động|AI diễn giải đang ngoại tuyến/).first(),
    ).toBeVisible();
    await context.close();
  }
});

test("ambiguous matching blocks confirmation and retry", async ({ browser }) => {
  const fixture = fixtures.find((item) => item.flow === "ambiguous");
  const context = await browser.newContext();
  await seedAuth(context, appUser);
  const page = await context.newPage();
  const { state } = await openConvertedRepair(page, appUser, fixture);
  await uploadRepairFile(page, fixture);
  await page.getByLabel("Cột thông báo MISA").selectOption({ label: "Thông báo kỹ thuật" });
  await page.getByLabel("Cột số chứng từ").selectOption({ label: "Số chứng từ" });
  await page.getByRole("button", { name: "Xác nhận ghép cột" }).click();
  await expect(page.getByRole("button", { name: /5 Xuất lại chứng từ thất bại/ })).toBeDisabled();
  expect(state.requests.some((request) => request.url().includes("/retry-batches"))).toBe(false);
  await context.close();
});

test("unknown import status alone blocks retry after matching and correction", async ({ browser }) => {
  const fixture = fixtures.find((item) => item.flow === "unknown");
  const context = await browser.newContext();
  await seedAuth(context, appUser);
  const page = await context.newPage();
  const { state } = await openConvertedRepair(page, appUser, fixture);
  await uploadRepairFile(page, fixture);
  await page.getByLabel("Cột thông báo MISA").selectOption({ label: "Thông báo kỹ thuật" });
  await page.getByLabel("Cột số chứng từ").selectOption({ label: "Số chứng từ" });
  await page.getByRole("button", { name: "Xác nhận ghép cột" }).click();
  const issueTable = page.locator("table");
  await issueTable.getByRole("button", { name: "Xác nhận ghép" }).click();
  await issueTable.getByLabel(/Trường cần sửa cho dòng/).fill("Mã hàng");
  await issueTable.getByLabel(/Giá trị sửa cho dòng/).fill("HH-FIXED");
  await issueTable.getByRole("button", { name: "Áp dụng cách sửa" }).click();
  await page.getByRole("button", { name: /5 Xuất lại chứng từ thất bại/ }).click();
  await expect(page.getByText("Còn chứng từ chưa xác nhận đã import hay thất bại.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tạo file xuất lại" })).toBeDisabled();
  expect(state.requests.some((request) => request.method() === "POST" && request.url().includes("/retry-batches"))).toBe(false);
  await context.close();
});

test("negative production journeys assert HTTP 403/410/503 and preserve the original flow", async ({ browser }) => {

  const foreignContext = await browser.newContext();
  await seedAuth(foreignContext, otherUser);
  await foreignContext.addInitScript(() => localStorage.setItem("ezformat:misa-repair:v1:task9-user-b", JSON.stringify({ repairId: "repair-cross-user", runId: "run-cross" })));
  const foreignPage = await foreignContext.newPage();
  const foreignState = installApiRoutes(foreignPage, otherUser);
  const deniedResponse = foreignPage.waitForResponse((response) => response.url().includes("/api/converter/import-repairs/repair-cross-user"));
  await foreignPage.goto(`${appOrigin}/convert`, { waitUntil: "domcontentloaded" });
  const denied = await deniedResponse;
  expect(denied.status()).toBe(403);
  expect(await denied.text()).toContain("Không có quyền truy cập phiên sửa lỗi");
  await expect(
    foreignPage.getByText("Không có quyền truy cập phiên sửa lỗi của người dùng khác", { exact: true }).first(),
  ).toBeVisible();
  expect(foreignState.requests.some((request) => request.url().includes("/api/converter/import-repairs/repair-cross-user"))).toBe(true);
  await foreignContext.close();

  const expiredContext = await browser.newContext();
  await seedAuth(expiredContext, appUser);
  const expiredPage = await expiredContext.newPage();
  const expiredState = installApiRoutes(expiredPage, appUser, { expire: true });
  const expiredFixture = fixtures.find((item) => item.flow === "expired");
  await openConvertedRepair(expiredPage, appUser, expiredFixture, { expire: true });
  const expiredResponsePromise = expiredPage.waitForResponse((response) => response.url().endsWith("/api/converter/import-repairs"));
  await uploadRepairFile(expiredPage, expiredFixture);
  const expiredResponse = await expiredResponsePromise;
  expect(expiredResponse.status()).toBe(410);
  expect(await expiredResponse.text()).toContain("hết hạn");
  await expect(expiredPage.getByText("Phiên sửa lỗi đã hết hạn", { exact: false })).toBeVisible();
  expect(expiredState.requests.some((request) => request.url().endsWith("/api/converter/import-repairs"))).toBe(true);
  await expiredContext.close();

  const offlineContext = await browser.newContext();
  await seedAuth(offlineContext, appUser);
  const offlinePage = await offlineContext.newPage();
  const { state: offlineState } = await openConvertedRepair(offlinePage, appUser, fixtures[1], { converterOffline: true });
  const offlineResponsePromise = offlinePage.waitForResponse((response) => response.url().endsWith("/api/converter/import-repairs"));
  await uploadRepairFile(offlinePage, fixtures[1]);
  expect((await offlineResponsePromise).status()).toBe(503);
  await expect(offlinePage.getByText("Không thể kết nối Converter", { exact: false })).toBeVisible();
  await expect(offlinePage.getByText("Đã xuất file kết quả", { exact: false })).toBeVisible();
  expect(offlineState.requests.some((request) => request.url().endsWith("/api/converter/import-repairs"))).toBe(true);
  await offlineContext.close();
});

test("focused QA wiring validates the canonical root and invokes the repair wrapper once", async () => {
  const qaQc = await readFile(path.join(repoRoot, "scripts", "qa-qc.ps1"), "utf8");
  const wrapper = await readFile(path.join(repoRoot, "scripts", "qa-misa-import-repair.ps1"), "utf8");
  assert.equal((qaQc.match(/qa-misa-import-repair\.ps1/g) || []).length, 1);
  assert.match(
    qaQc,
    /if \(\$SkipSlowTests\) \{\s*& \$repairGate -RepoRoot \$RepoRoot -SkipSlowTests\s*\} else \{\s*& \$repairGate -RepoRoot \$RepoRoot\s*\}/,
  );
  assert.match(wrapper, /Resolve-Path/);
  assert.match(wrapper, /try\s*\{/);
  assert.match(wrapper, /finally\s*\{/);
  assert.match(wrapper, /package\.json[\s\S]*Test-Path/);
  assert.doesNotMatch(qaQc, /test:converter-gateway-integration|test:converter-gateway-api-integration/);
});

test("production repair surface contains no raw workbook/log output", async () => {
  const panel = await readFile(path.join(frontendRoot, "src", "components", "import-repair", "MisaImportRepairPanel.jsx"), "utf8");
  assert.doesNotMatch(panel, /console\.log|raw workbook/i);
  assert.match(panel, /410/);
});

test("warning journey is keyboard-only, screen-reader-labelled, and mobile-safe at 375px", async ({ browser }) => {
  const fixture = fixtures.find((item) => item.flow === "warnings");
  const contract = workbookContract(fixture);
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await seedAuth(context, appUser);
  const page = await context.newPage();
  const state = installApiRoutes(page, appUser);
  await page.goto(`${appOrigin}/convert`, { waitUntil: "domcontentloaded" });
  const originalFileButton = page.getByRole("button", { name: "Chọn file Excel" });
  await expect(originalFileButton).toBeVisible();
  await expect(page.locator('input[type="file"]').first()).toHaveAttribute("accept", ".xlsx,.xls,.pdf");
  await assertNoHorizontalOverflow(page);
  await keyboardChooseFile(page, originalFileButton, { name: fixture.name, mimeType: contract.mimeType, buffer: workbookBytes(fixture) });
  await keyboardActivate(page, page.getByRole("button", { name: "Phân tích & gợi ý ghép cột", exact: true }));
  await expect(page.getByRole("heading", { name: "Ghép cột Excel → Chuẩn định dạng kế toán" })).toBeVisible({ timeout: 20_000 });
  await keyboardActivate(page, page.getByRole("button", { name: "Xem trước", exact: true }).first());
  await keyboardActivate(page, page.getByRole("button", { name: "Kiểm tra lỗi", exact: true }).first());
  const originalExportButton = page.getByRole("button", { name: "Tải file MISA", exact: true }).first();
  await expect(originalExportButton).toBeEnabled({ timeout: 20_000 });
  const originalDownloadPromise = page.waitForEvent("download");
  const originalResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/converter/conversions/export"));
  await keyboardActivate(page, originalExportButton);
  const originalDownload = await originalDownloadPromise;
  const originalResponse = await originalResponsePromise;
  assertWorkbook(await readFile(await originalDownload.path()), fixture, { filename: originalDownload.suggestedFilename(), mimeType: originalResponse.headers()["content-type"] });

  const guideButton = page.getByRole("button", { name: "Xem hướng dẫn" });
  await keyboardActivate(page, guideButton);
  const guide = page.getByRole("dialog", { name: "Đi cùng bạn tới lần import đầu tiên" });
  await expect(guide).toBeVisible();
  await expect(page.getByRole("button", { name: "Đóng hướng dẫn" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(guideButton).toBeFocused();

  await keyboardActivate(page, page.getByRole("button", { name: "Tải file lỗi lên" }));
  const repairFileButton = page.getByRole("button", { name: "Chọn file lỗi MISA" });
  await keyboardChooseFile(page, repairFileButton, { name: fixture.name, mimeType: contract.mimeType, buffer: workbookBytes(fixture) });
  await expect(page.locator("#repair-upload-help")).toBeVisible();
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: fixture.name })).toBeVisible();
  await keyboardActivate(page, page.getByRole("button", { name: "Phân tích file lỗi" }));

  await expect(page.getByText(/Chỉ cột thông báo MISA là bắt buộc/)).toBeVisible();
  const technicalMapping = page.getByLabel("Cột thông báo MISA");
  await technicalMapping.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(technicalMapping).toHaveValue("Thông báo kỹ thuật");
  const documentMapping = page.getByLabel("Cột số chứng từ");
  await documentMapping.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(documentMapping).toHaveValue("Số chứng từ");
  await keyboardActivate(page, page.getByRole("button", { name: "Xác nhận ghép cột" }));

  const mobileIssues = page.getByRole("region", { name: "Danh sách lỗi import MISA trên di động" });
  await expect(mobileIssues).toBeVisible();
  await keyboardActivate(page, mobileIssues.getByRole("button", { name: "Xác nhận ghép" }));
  const statusSelect = page.locator("select").filter({ hasText: "Thất bại" }).first();
  await statusSelect.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const wholeDocumentAcknowledgement = page.getByLabel("Toàn bộ chứng từ này chưa được MISA nhập");
  await keyboardActivate(page, wholeDocumentAcknowledgement, "Space");
  await keyboardActivate(page, page.getByRole("button", { name: "Xác nhận chứng từ thất bại" }));
  const fieldInput = mobileIssues.getByLabel(/Trường cần sửa cho dòng/);
  await fieldInput.focus();
  await page.keyboard.type("Mã hàng");
  const valueInput = mobileIssues.getByLabel(/Giá trị sửa cho dòng/);
  await valueInput.focus();
  await page.keyboard.type("HH-FIXED");
  await keyboardActivate(page, mobileIssues.getByRole("button", { name: "Áp dụng cách sửa" }));
  const retryReviewStep = page.getByRole("button", { name: /5 Xuất lại chứng từ thất bại/ });
  await expect(retryReviewStep).toBeEnabled();
  await keyboardActivate(page, retryReviewStep);

  const warningAcknowledgement = page.getByLabel(/Tôi đã rà soát 1 cảnh báo/);
  await warningAcknowledgement.focus();
  await page.keyboard.press("Space");
  await expect(warningAcknowledgement).toBeChecked();
  await keyboardActivate(page, page.getByRole("button", { name: "Tạo file xuất lại" }));
  const retryDownloadPromise = page.waitForEvent("download");
  const retryResponsePromise = page.waitForResponse((response) => response.url().includes("/retry-batches/") && response.url().endsWith("/download"));
  await keyboardActivate(page, page.getByRole("button", { name: "Tải file xuất lại" }));
  const retryDownload = await retryDownloadPromise;
  const retryResponse = await retryResponsePromise;
  assertWorkbook(await readFile(await retryDownload.path()), fixture, { retry: true, filename: retryDownload.suggestedFilename(), mimeType: retryResponse.headers()["content-type"] });
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: /Đã tải file chứng từ thất bại/ })).toBeAttached();
  await assertNoHorizontalOverflow(page);
  expect(state.mapping).toEqual({ technical_message: "Thông báo kỹ thuật", document_number: "Số chứng từ" });
  await context.close();
});
