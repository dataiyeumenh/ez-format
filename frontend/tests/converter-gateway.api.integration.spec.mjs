import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const live = process.env.QA_EXPECT_LIVE === "true";
const gatewayOrigin = String(process.env.QA_GATEWAY_URL || "").replace(/\/$/, "");
const converterOrigin = String(process.env.QA_CONVERTER_URL || "").replace(/\/$/, "");
const ownerJwt = String(process.env.QA_OWNER_JWT || "");
const releaseId = String(process.env.QA_RELEASE_ID || "");
const rawFixture = String(process.env.QA_RAW_FIXTURE || "");

test.describe("converter gateway production-like journey", () => {
  test.skip(!live, "Set QA_EXPECT_LIVE=true through the release gate");
  test.setTimeout(120_000);

  test("real stack blocks direct FastAPI access, missing JWT, and export with readiness blockers", async ({ request }) => {
    for (const [label, value] of Object.entries({ gatewayOrigin, converterOrigin, ownerJwt, releaseId, rawFixture })) {
      expect(value, `${label} is required`).not.toBe("");
    }
    expect(new URL(gatewayOrigin).origin).not.toBe(new URL(converterOrigin).origin);

    const direct = await request.post(`${converterOrigin}/api/v1/conversions/export`, {
      data: { upload_id: "qa-no-service-token" },
    });
    expect(direct.status()).toBe(401);

    const missingJwt = await request.post(`${gatewayOrigin}/api/converter/uploads/analyze`);
    expect(missingJwt.status()).toBe(401);

    const fixtureBytes = await readFile(rawFixture);
    const analyze = await request.post(`${gatewayOrigin}/api/converter/uploads/analyze`, {
      headers: {
        Authorization: `Bearer ${ownerJwt}`,
        "Idempotency-Key": `qa-${releaseId}-blocked-journey`,
      },
      multipart: {
        file: {
          name: path.basename(rawFixture),
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: fixtureBytes,
        },
        target_template_id: "bsn_sales",
        use_ai: "false",
      },
    });
    expect(analyze.status(), await analyze.text()).toBe(200);
    const analyzed = await analyze.json();
    const suggestion = analyzed.mapping_suggestion || analyzed.suggestion || {};
    const session = analyzed.session || {};
    const uploadId = analyzed.upload_id;
    const runId = analyzed.runId || analyzed.conversionRunId || analyzed.conversion_run_id;
    const targetTemplateId = analyzed.target_template_id;
    const operationSessionId = analyzed.operation_session_id || session.session_id;
    const contextToken = analyzed.contextToken;
    const revision = session.active_revision;
    const stateHash = session.state_hash;
    for (const [label, value] of Object.entries({ uploadId, runId, targetTemplateId, operationSessionId, contextToken, revision, stateHash })) {
      expect(value, `analyze response missing ${label}`).toBeTruthy();
    }

    const mapping = structuredClone(suggestion.mapping || {});
    const defaults = structuredClone(suggestion.defaults || {});
    const formulas = structuredClone(suggestion.formulas || {});
    for (const source of Object.keys(mapping)) {
      const targets = Array.isArray(mapping[source]) ? mapping[source] : [mapping[source]];
      if (targets.some((target) => ["TK Tiền/Chi phí/Nợ (*)", "TK Doanh thu/Có (*)"].includes(target))) {
        delete mapping[source];
      }
    }
    delete defaults["TK Tiền/Chi phí/Nợ (*)"];
    delete defaults["TK Doanh thu/Có (*)"];
    delete formulas["TK Tiền/Chi phí/Nợ (*)"];
    delete formulas["TK Doanh thu/Có (*)"];

    const operationBody = {
      upload_id: uploadId,
      target_template_id: targetTemplateId,
      conversion_run_id: runId,
      session_id: operationSessionId,
      revision,
      state_hash: stateHash,
      mapping,
      defaults,
      formulas,
    };
    const operationHeaders = {
      Authorization: `Bearer ${ownerJwt}`,
      "X-Conversion-Context": contextToken,
    };

    const preview = await request.post(`${gatewayOrigin}/api/converter/mappings/preview`, {
      headers: operationHeaders,
      data: operationBody,
    });
    expect(preview.status(), await preview.text()).toBe(200);

    const readiness = await request.post(`${gatewayOrigin}/api/converter/mappings/readiness`, {
      headers: operationHeaders,
      data: operationBody,
    });
    expect(readiness.status(), await readiness.text()).toBe(200);
    const readinessPayload = await readiness.json();
    expect(Number(readinessPayload.summary?.blocker || 0)).toBeGreaterThan(0);

    const confirm = await request.post(`${gatewayOrigin}/api/converter/mappings/confirm`, {
      headers: operationHeaders,
      data: {
        ...operationBody,
        profile_name: `QA blocked ${releaseId}`,
      },
    });
    expect(confirm.status(), await confirm.text()).toBe(200);
    const confirmed = await confirm.json();
    expect(confirmed.profile_id).toBeTruthy();
    const confirmedSession = confirmed.session || session;

    const refresh = await request.post(`${gatewayOrigin}/api/converter/runs/${encodeURIComponent(runId)}/context`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
      data: {
        upload_id: uploadId,
        target_template_id: targetTemplateId,
        operation_session_id: operationSessionId,
      },
    });
    expect(refresh.status(), await refresh.text()).toBe(200);
    const freshContext = (await refresh.json()).contextToken;
    expect(freshContext).toBeTruthy();

    const blockedExport = await request.post(`${gatewayOrigin}/api/converter/conversions/export`, {
      headers: {
        Authorization: `Bearer ${ownerJwt}`,
        "X-Conversion-Context": freshContext,
        "Idempotency-Key": `qa-${releaseId}-blocked-export`,
      },
      data: {
        upload_id: uploadId,
        profile_id: confirmed.profile_id,
        run_id: runId,
        conversion_run_id: runId,
        target_template_id: targetTemplateId,
        session_id: operationSessionId,
        revision: confirmedSession.active_revision,
        state_hash: confirmedSession.state_hash,
        acknowledge_warnings: true,
      },
    });
    expect(blockedExport.status(), await blockedExport.text()).toBe(422);
    const blockedPayload = await blockedExport.json();
    expect(Number(blockedPayload.summary?.blocker || 0)).toBeGreaterThan(0);
  });
});
