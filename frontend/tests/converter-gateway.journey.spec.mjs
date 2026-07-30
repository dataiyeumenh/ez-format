import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(frontendRoot, "..");
const maxUploadBytes = 20 * 1024 * 1024;

function createGatewayMock() {
  const state = {
    artifacts: new Map(),
    charges: 0,
    failNextExport: false,
    runs: new Map(),
  };

  function requireActor(actor) {
    return actor ? null : { status: 401, body: { code: "missing_jwt" } };
  }

  function ownedRun(actor, runId, workspaceId) {
    const run = state.runs.get(runId);
    if (!run || run.owner !== actor.id) return { status: 403, body: { code: "foreign_run" } };
    if (workspaceId && workspaceId !== run.workspaceId) {
      return { status: 409, body: { code: "workspace_context_mismatch" } };
    }
    return run;
  }

  return {
    state,
    directConverter({ origin, serviceToken }) {
      if (!serviceToken) return { status: 401, headers: {} };
      return {
        status: 200,
        headers: origin === "https://app.ezformat.test"
          ? { "access-control-allow-origin": origin }
          : {},
      };
    },
    analyze({ actor, bytes, workspaceId }) {
      const denied = requireActor(actor);
      if (denied) return denied;
      if (bytes > maxUploadBytes) return { status: 413, body: { code: "file_too_large" } };
      if (!actor.hasCredit) return { status: 402, body: { code: "no_credit" } };
      if (workspaceId !== actor.workspaceId) {
        return { status: 403, body: { code: "foreign_workspace" } };
      }
      const runId = `run-${state.runs.size + 1}`;
      state.runs.set(runId, { owner: actor.id, workspaceId, warningsAcknowledged: false });
      return {
        status: 200,
        body: {
          ai: actor.aiOnline ? "ai" : "offline",
          runId,
          uploadId: `upload-${runId}`,
          mapping: { "Cột nguồn": "Mã hàng (*)" },
        },
      };
    },
    editMapping({ actor, runId, workspaceId }) {
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      return { status: 200, body: { revision: 2 } };
    },
    readiness({ actor, runId, workspaceId, warning = false, blocker = false }) {
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      run.blockerCount = Number(blocker);
      return { status: 200, body: { summary: { blocker: Number(blocker), warning: Number(warning) } } };
    },
    acknowledgeWarnings({ actor, runId, workspaceId }) {
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      run.warningsAcknowledged = true;
      return { status: 200, body: { acknowledged: true } };
    },
    preview({ actor, runId, workspaceId }) {
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      return { status: 200, body: { rows: [{ "Mã hàng (*)": "HH-01" }] } };
    },
    export({ actor, runId, workspaceId, profileOwner = actor?.id, warning = false }) {
      const denied = requireActor(actor);
      if (denied) return denied;
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      if (run.blockerCount > 0) return { status: 422, body: { code: "readiness_blocked" } };
      if (profileOwner !== actor.id) return { status: 403, body: { code: "foreign_profile" } };
      if (warning && !run.warningsAcknowledged) return { status: 422, body: { code: "warning_ack_required" } };
      if (state.failNextExport) {
        state.failNextExport = false;
        throw new Error("network unavailable");
      }
      if (!state.artifacts.has(runId)) {
        state.charges += 1;
        state.artifacts.set(runId, { id: `artifact-${runId}`, bytes: 1024 });
      }
      return { status: 200, body: state.artifacts.get(runId) };
    },
    adminHistory({ actor }) {
      if (!actor?.admin) return { status: 403, body: { code: "admin_required" } };
      return { status: 200, body: { runs: [...state.runs.keys()] } };
    },
    studentAssistant({ actor, runId, workspaceId }) {
      const run = ownedRun(actor, runId, workspaceId);
      if (run.status) return run;
      return { status: 200, body: { anonymized: true, answer: "Kiểm tra định khoản" } };
    },
  };
}

test("journey suite is reachable by a dedicated frontend command", async () => {
  const packageJson = JSON.parse(await readFile(path.join(frontendRoot, "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:converter-gateway-journey"] || "", /tests\/converter-gateway\.journey\.spec\.mjs/);
});

test("production-like gateway rejects direct FastAPI access, CORS bypass, missing JWT, and oversize upload", () => {
  const gateway = createGatewayMock();
  const user = { id: "user-a", workspaceId: "workspace-a", hasCredit: true, aiOnline: true };

  assert.equal(gateway.directConverter({}).status, 401);
  assert.equal(gateway.directConverter({ origin: "https://evil.example" }).status, 401);
  const cors = gateway.directConverter({ origin: "https://evil.example", serviceToken: "internal" });
  assert.equal(cors.headers["access-control-allow-origin"], undefined);
  assert.equal(gateway.analyze({ bytes: 1, workspaceId: user.workspaceId }).status, 401);
  assert.equal(gateway.analyze({ actor: user, bytes: maxUploadBytes + 1, workspaceId: user.workspaceId }).status, 413);
});

test("authenticated journey covers credit, analyze, mapping, readiness, warning acknowledgement, preview, and AI states", () => {
  const gateway = createGatewayMock();
  const noCredit = { id: "user-no-credit", workspaceId: "workspace-a", hasCredit: false, aiOnline: false };
  const user = { id: "user-a", workspaceId: "workspace-a", hasCredit: true, aiOnline: true };
  const offlineUser = { id: "user-offline", workspaceId: "workspace-a", hasCredit: true, aiOnline: false };

  assert.equal(gateway.analyze({ actor: noCredit, bytes: 1, workspaceId: "workspace-a" }).status, 402);
  const analyze = gateway.analyze({ actor: user, bytes: 1, workspaceId: "workspace-a" });
  assert.equal(analyze.status, 200);
  assert.equal(analyze.body.ai, "ai");
  assert.equal(gateway.editMapping({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a" }).status, 200);
  assert.equal(gateway.readiness({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a", blocker: true }).body.summary.blocker, 1);
  assert.equal(
    gateway.export({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a" }).status,
    422,
    "a readiness blocker must prevent export",
  );
  assert.equal(gateway.export({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a", warning: true }).status, 422);
  assert.equal(gateway.acknowledgeWarnings({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a" }).status, 200);
  assert.equal(gateway.preview({ actor: user, runId: analyze.body.runId, workspaceId: "workspace-a" }).body.rows.length, 1);

  const offline = gateway.analyze({ actor: offlineUser, bytes: 1, workspaceId: "workspace-a" });
  assert.equal(offline.status, 200);
  assert.equal(offline.body.ai, "offline");
});

test("release gate contracts are fixed, evidence-bound, and production-strict", async () => {
  const gatewayGate = await readFile(path.join(repoRoot, "scripts/qa-converter-gateway.ps1"), "utf8");
  const accountingGate = await readFile(path.join(repoRoot, "scripts/qa-accounting-operations.ps1"), "utf8");
  const releaseDoc = await readFile(path.join(repoRoot, "docs/qa/converter-gateway-release-gate.md"), "utf8");
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const frontendPackage = JSON.parse(await readFile(path.join(frontendRoot, "package.json"), "utf8"));

  assert.match(gatewayGate, /Assert-AllowedOrigin/);
  assert.match(gatewayGate, /Assert-LiveContractSchema/);
  assert.match(gatewayGate, /oversized-upload.*413/is);
  assert.match(gatewayGate, /ChargeAuditBeforeFile/);
  assert.match(gatewayGate, /ChargeAuditAfterFile/);
  assert.match(gatewayGate, /idempotency_key/);
  assert.match(gatewayGate, /artifact_id/);
  assert.match(gatewayGate, /exit 2/);
  assert.match(gatewayGate, /FrontendUrl/);
  assert.match(gatewayGate, /QA_OWNER_EMAIL/);
  assert.match(gatewayGate, /QA_OWNER_PASSWORD/);
  assert.match(gatewayGate, /playwright-live-ui-journey/);
  assert.match(gatewayGate, /playwright-live-api-security/);
  assert.match(gatewayGate, /function Restore-Environment/);
  assert.match(gatewayGate, /Remove-Item -Path "env:\$name"/);
  assert.doesNotMatch(gatewayGate, /check\.base_url|check\.path|check\.method|check\.expected_status/);

  assert.match(accountingGate, /SalesRawFixture/);
  assert.match(accountingGate, /PurchaseRawFixture/);
  assert.match(accountingGate, /validate_mapping_semantics/);
  assert.match(accountingGate, /aggregate_document_totals/);
  assert.match(accountingGate, /fixture_sha256/);
  assert.match(accountingGate, /tree_hash/);
  assert.match(accountingGate, /qa_artifact_sha256/);
  assert.match(accountingGate, /Runs -lt 3|Runs\s*-lt\s*3/);

  assert.match(frontendPackage.scripts.test, /tests\/converter-gateway\.journey\.spec\.mjs/);
  assert.match(frontendPackage.scripts["test:converter-gateway-integration"] || "", /playwright test/);
  assert.match(frontendPackage.scripts["test:converter-gateway-api-integration"] || "", /playwright test/);
  assert.match(rootPackage.scripts["qa:converter-gateway"] || "", /qa-converter-gateway\.ps1/);
  assert.match(releaseDoc, /10,?000[^\n]*20\s*s/i);
  assert.match(releaseDoc, /50,?000[^\n]*75\s*s/i);
  assert.doesNotMatch(releaseDoc, /"[A-Za-z]:\\(?!\\)/, "Windows paths in JSON examples must be escaped");

  const uiJourney = await readFile(
    path.join(frontendRoot, "tests/converter-gateway.integration.spec.mjs"),
    "utf8",
  );
  const apiSecurity = await readFile(
    path.join(frontendRoot, "tests/converter-gateway.api.integration.spec.mjs"),
    "utf8",
  );
  assert.match(uiJourney, /page\.goto/);
  assert.match(uiJourney, /setInputFiles/);
  assert.match(uiJourney, /waitForEvent\(["']download["']\)/);
  assert.match(uiJourney, /width:\s*390/);
  assert.match(uiJourney, /AI offline/);
  assert.match(uiJourney, /AI Gateway online/);
  assert.match(apiSecurity, /direct access|direct FastAPI|direct converter/i);
  assert.match(apiSecurity, /missing JWT|without JWT/i);
});

test("workspace, upload/run/profile ownership, retry, and duplicate export fail closed or stay idempotent", () => {
  const gateway = createGatewayMock();
  const owner = { id: "owner", workspaceId: "workspace-a", hasCredit: true, aiOnline: false };
  const foreign = { id: "foreign", workspaceId: "workspace-b", hasCredit: true, aiOnline: false };
  const analyze = gateway.analyze({ actor: owner, bytes: 1, workspaceId: "workspace-a" });
  const runId = analyze.body.runId;

  assert.equal(gateway.editMapping({ actor: owner, runId, workspaceId: "workspace-b" }).status, 409);
  assert.equal(gateway.preview({ actor: foreign, runId, workspaceId: "workspace-a" }).status, 403);
  assert.equal(gateway.export({ actor: owner, runId, workspaceId: "workspace-a", profileOwner: foreign.id }).status, 403);

  gateway.state.failNextExport = true;
  assert.throws(() => gateway.export({ actor: owner, runId, workspaceId: "workspace-a" }), /network unavailable/);
  const retry = gateway.export({ actor: owner, runId, workspaceId: "workspace-a" });
  const duplicate = gateway.export({ actor: owner, runId, workspaceId: "workspace-a" });
  assert.equal(retry.status, 200);
  assert.deepEqual(duplicate.body, retry.body);
  assert.equal(gateway.state.charges, 1);
  assert.equal(gateway.state.artifacts.size, 1);
});

test("admin history, Student Assistant, and 390px mobile journey keep ownership boundaries", async () => {
  const gateway = createGatewayMock();
  const user = { id: "student", workspaceId: "workspace-a", hasCredit: true, aiOnline: false };
  const admin = { id: "admin", admin: true };
  const runId = gateway.analyze({ actor: user, bytes: 1, workspaceId: "workspace-a" }).body.runId;

  assert.equal(gateway.adminHistory({ actor: user }).status, 403);
  assert.equal(gateway.adminHistory({ actor: admin }).body.runs.length, 1);
  assert.equal(gateway.studentAssistant({ actor: user, runId, workspaceId: "workspace-a" }).body.anonymized, true);

  const convertPage = await readFile(path.join(frontendRoot, "src/pages/ConvertPage.jsx"), "utf8");
  const assistant = await readFile(path.join(frontendRoot, "src/components/converter/AccountingAssistantDrawer.jsx"), "utf8");
  assert.match(convertPage, /max-w-|sm:|md:/, "390px viewport has responsive utility coverage");
  assert.match(assistant, /Tra cứu và phép tính xác định vẫn hoạt động/);
});

test("MISA import repair journey exposes five gated steps without raw workbooks or confidence", async () => {
  const panel = await readFile(
    path.join(frontendRoot, "src/components/import-repair/MisaImportRepairPanel.jsx"),
    "utf8",
  );
  const hook = await readFile(path.join(frontendRoot, "src/hooks/useConverterApi.js"), "utf8");

  for (const step of [
    "Chọn conversion run + upload file lỗi",
    "Ghép cột file lỗi",
    "Xác nhận lỗi thuộc chứng từ nào",
    "Sửa và kiểm tra lại",
    "Xuất lại chứng từ thất bại",
  ]) {
    assert.ok(panel.includes(step), `missing repair step: ${step}`);
  }
  assert.match(panel, /misa_import_repair\?\.enabled/);
  assert.match(panel, /409|410|422/);
  assert.doesNotMatch(panel, /confidence/i);
  assert.doesNotMatch(panel, /workbook\s*\./i);
  assert.match(hook, /expected_version/);
  assert.match(hook, /Idempotency-Key/);
});

test("MISA import repair accepts only backend artifacts and recovers reviewed states", async () => {
  const upload = await readFile(
    path.join(frontendRoot, "src/components/import-repair/ImportResultUploadStep.jsx"),
    "utf8",
  );
  const panel = await readFile(
    path.join(frontendRoot, "src/components/import-repair/MisaImportRepairPanel.jsx"),
    "utf8",
  );
  const workspace = await readFile(
    path.join(frontendRoot, "src/components/import-repair/ImportIssueWorkspace.jsx"),
    "utf8",
  );
  const guide = await readFile(
    path.join(frontendRoot, "src/components/import-repair/MisaNewUserGuide.jsx"),
    "utf8",
  );
  const styles = await readFile(path.join(frontendRoot, "src/index.css"), "utf8");

  assert.match(upload, /accept="\.xls,\.xlsx"/);
  assert.doesNotMatch(upload, /\.csv/);
  assert.match(panel, /"failed_rows"/);
  assert.match(panel, /ezformat:misa-repair:v1:/);
  assert.match(panel, /Phiên sửa lỗi đã thay đổi/);
  assert.match(panel, /Kết nối lại dịch vụ/);
  assert.match(panel, /setOpen\(true\);\s*setRecovery\("stale"\)/);
  assert.match(panel, /setOpen\(true\);\s*setRecovery\("offline"\)/);
  assert.match(workspace, /Ghép thủ công với chứng từ/);
  assert.match(workspace, /documentGroupStatuses/);
  assert.match(workspace, /md:hidden/);
  assert.match(workspace, /w-full[^\n]*Xác nhận ghép/);
  assert.match(guide, /trapFocus/);
  assert.match(guide, /inert/);
  assert.match(styles, /\.animate-slide-up\s*\{\s*animation:\s*none;/s);
});
