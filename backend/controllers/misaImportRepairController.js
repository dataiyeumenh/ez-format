const crypto = require("node:crypto");
const repairService = require("../services/misaImportRepairService");

function auditSummaryCount(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? Math.min(normalized, 1_000_000_000)
    : 0;
}

function summaryAuditMetrics(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  return {
    issueCount: auditSummaryCount(summary.totalIssues),
    matchStatusCounts: {
      unmatched: auditSummaryCount(summary.unmatchedIssues),
      ambiguous: auditSummaryCount(summary.ambiguousIssues),
      confirmed: auditSummaryCount(summary.confirmedIssues),
    },
  };
}

function sessionAuditMetrics(session) {
  if (!session) return {};
  const summary = session.summary || {};
  return {
    repairId: session._id,
    conversionRunId: session.conversionRun,
    workspaceId: session.workspace?._id || session.workspace,
    adapterId: session.adapter?.id,
    artifactType: session.artifactType,
    ...summaryAuditMetrics(summary),
  };
}

function setAuditMetrics(res, metrics) {
  res.locals = res.locals || {};
  res.locals.misaImportRepairAudit = metrics;
}

function requestAuditMetadata(req, auditRequestId) {
  const metadata = { requestId: auditRequestId, adapterId: "manual_excel_v1" };
  const repairId = req.params?.repairId;
  const conversionRunId =
    req.body?.conversionRunId ||
    req.body?.conversion_run_id ||
    req.body?.runId ||
    req.body?.run_id;
  const artifactType = req.body?.artifactType || req.body?.artifact_type;
  const retryBatchId = req.params?.batchId;
  if (repairId) metadata.repairId = repairId;
  if (conversionRunId) metadata.conversionRunId = conversionRunId;
  if (artifactType) metadata.artifactType = artifactType;
  if (retryBatchId) metadata.retryBatchId = retryBatchId;
  return metadata;
}

function extractMisaImportRepairAuditMetrics(body) {
  const summary = body?.summary || body?.session?.summary;
  return summaryAuditMetrics(summary);
}

function captureAuditResponse(res) {
  res.locals = res.locals || {};
  if (typeof res.json !== "function") return () => {};
  const originalJson = res.json;
  res.json = function captureMisaImportRepairResponse(body) {
    res.locals.misaImportRepairResponse = body;
    return originalJson.call(this, body);
  };
  return () => {
    res.json = originalJson;
  };
}

function metricStatus(statusCode) {
  if (statusCode < 400) return "success";
  return statusCode < 500 ? "client_error" : "server_error";
}

function metricReason(statusCode) {
  if (String(process.env.MISA_IMPORT_REPAIR_ENABLED || "false").trim().toLowerCase() !== "true") {
    return "disabled";
  }
  if ([502, 503, 504].includes(statusCode)) return "upstream";
  if (statusCode === 410) return "expired";
  if (statusCode === 409) return "conflict";
  if (statusCode === 404) return "not_found";
  if ([400, 401, 403, 422, 429].includes(statusCode)) return "validation";
  if (statusCode >= 500) return "internal";
  return "none";
}

function auditedHandler(operation, handler) {
  return async function auditedMisaImportRepairHandler(req, res, next) {
    const startedAt = Date.now();
    const auditRequestId = crypto.randomUUID();
    const restoreResponse = captureAuditResponse(res);
    let thrown = null;
    try {
      return await handler(req, res, next);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const statusCode = thrown
        ? Number(thrown.statusCode) || 500
        : Number(res.statusCode) || 500;
      const outcome = statusCode >= 500
        ? "failed"
        : statusCode >= 400
          ? "rejected"
          : "completed";
      repairService.emitMisaImportRepairAuditEvent({
        ...requestAuditMetadata(req, auditRequestId),
        ...(res.locals?.misaImportRepairAudit || {}),
        ...extractMisaImportRepairAuditMetrics(res.locals?.misaImportRepairResponse),
        event: `misa_import_repair.${operation}.${outcome}`,
        durationMs: Date.now() - startedAt,
        statusCode,
      });
      repairService.emitMisaImportRepairMetric({
        operation,
        outcome,
        reason: metricReason(statusCode),
        status: metricStatus(statusCode),
        durationMs: Date.now() - startedAt,
      });
      restoreResponse();
    }
  };
}

function assertEnabled() {
  if (String(process.env.MISA_IMPORT_REPAIR_ENABLED || "false").trim().toLowerCase() !== "true") {
    const error = new Error("MISA import repair chưa được bật");
    error.statusCode = 404;
    throw error;
  }
}

function sendGatewayError(req, res, error) {
  const statusCode = Number(error.statusCode) || 500;
  return res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500 && ![502, 503, 504].includes(statusCode)
        ? "Không thể xử lý yêu cầu Converter"
        : error.message,
    requestId: req.requestId || "",
  });
}

function batchResponse(batch, idempotent = false) {
  return {
    batchId: String(batch?._id || ""),
    status: String(batch?.status || ""),
    documentGroupIds: Array.isArray(batch?.documentGroupIds) ? batch.documentGroupIds : [],
    readinessSummary: {
      fatal: Number(batch?.readinessSummary?.fatal || 0),
      blocker: Number(batch?.readinessSummary?.blocker || 0),
      warning: Number(batch?.readinessSummary?.warning || 0),
      info: Number(batch?.readinessSummary?.info || 0),
    },
    idempotent,
  };
}

async function createMisaImportRepair(req, res) {
  try {
    assertEnabled();
    const result = await repairService.createSession({
      userId: req.user?._id,
      runId: req.body?.conversionRunId || req.body?.conversion_run_id,
      file: req.file,
      artifactType: req.body?.artifactType || req.body?.artifact_type,
      idempotencyKey:
        req.headers?.["idempotency-key"] ||
        req.body?.idempotency_key ||
        req.body?.idempotencyKey,
      requestId: req.requestId,
    });
    return res.status(result.idempotent ? 200 : 201).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      artifactType: result.session.artifactType,
      adapter: { id: "manual_excel_v1", version: 1, verified: false },
      workbook: result.inspection,
      idempotent: result.idempotent,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function submitMisaImportRepairSchema(req, res) {
  try {
    assertEnabled();
    const result = await repairService.submitSchema({
      userId: req.user?._id,
      repairId: req.params.repairId,
      body: req.body,
      requestId: req.requestId,
    });
    return res.status(200).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      summary: result.session.summary,
      issues: result.issues,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function readMisaImportRepair(req, res) {
  try {
    assertEnabled();
    const result = await repairService.readWorkspace({
      userId: req.user?._id,
      repairId: req.params.repairId,
      status: req.query?.status,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      groupCursor: req.query?.group_cursor,
      groupLimit: req.query?.group_limit,
      requestId: req.requestId,
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function confirmMisaImportRepairMatch(req, res) {
  try {
    assertEnabled();
    const result = await repairService.confirmMatch({
      userId: req.user?._id,
      repairId: req.params.repairId,
      issueId: req.params.issueId,
      body: req.body,
      humanConfirmationToken: req.headers?.["x-human-confirmation-token"],
    });
    return res.status(200).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      summary: result.session.summary,
      issue: result.issue,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function setMisaImportRepairImportStatus(req, res) {
  try {
    assertEnabled();
    const result = await repairService.setImportStatus({
      userId: req.user?._id,
      repairId: req.params.repairId,
      groupId: req.params.groupId,
      body: req.body,
      humanConfirmationToken: req.headers?.["x-human-confirmation-token"],
    });
    return res.status(200).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      summary: result.session.summary,
      documentGroup: result.group,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function issueMisaImportRepairHumanConfirmation(req, res) {
  try {
    assertEnabled();
    const result = await repairService.issueHumanConfirmation({
      userId: req.user?._id,
      repairId: req.params.repairId,
      action: req.body?.action,
      body: req.body?.payload,
      issueId: req.body?.issue_id || req.body?.issueId,
      groupId: req.body?.group_id || req.body?.groupId,
      requestId: req.requestId,
    });
    return res.status(201).json({
      action: result.action,
      confirmationToken: result.token,
      payloadHash: result.payloadHash,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function resolveMisaImportRepairIssue(req, res) {
  try {
    assertEnabled();
    const result = await repairService.resolveIssue({
      userId: req.user?._id,
      repairId: req.params.repairId,
      issueId: req.params.issueId,
      body: req.body,
      humanConfirmationToken: req.headers?.["x-human-confirmation-token"],
      requestId: req.requestId,
    });
    setAuditMetrics(res, sessionAuditMetrics(result.session));
    return res.status(200).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      summary: result.session.summary,
      issue: result.issue,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function simulateMisaImportRepairBulk(req, res) {
  try {
    assertEnabled();
    const result = await repairService.simulateBulk({
      userId: req.user?._id,
      repairId: req.params.repairId,
      body: req.body,
      requestId: req.requestId,
    });
    setAuditMetrics(res, { issueCount: result.affectedIssueCount });
    return res.status(200).json(result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function applyMisaImportRepairBulk(req, res) {
  try {
    assertEnabled();
    const result = await repairService.applyBulk({
      userId: req.user?._id,
      repairId: req.params.repairId,
      body: req.body,
      humanConfirmationToken: req.headers?.["x-human-confirmation-token"],
      requestId: req.requestId,
    });
    setAuditMetrics(res, {
      ...sessionAuditMetrics(result.session),
      issueCount: result.affectedIssueCount,
    });
    return res.status(200).json({
      repairId: String(result.session._id),
      status: result.session.status,
      version: result.session.version,
      summary: result.session.summary,
      affectedIssueCount: result.affectedIssueCount,
      simulationHash: result.simulationHash,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function createMisaImportRetryBatch(req, res) {
  try {
    assertEnabled();
    const result = await repairService.createRetryBatch({
      userId: req.user?._id,
      repairId: req.params.repairId,
      body: req.body,
      humanConfirmationToken: req.headers?.["x-human-confirmation-token"],
      idempotencyKey: req.headers?.["idempotency-key"],
      requestId: req.requestId,
    });
    setAuditMetrics(res, {
      ...sessionAuditMetrics(result.session),
      retryBatchId: result.batch?._id,
    });
    return res.status(result.idempotent ? 200 : 201).json(batchResponse(result.batch, result.idempotent));
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function downloadMisaImportRetryBatch(req, res) {
  try {
    assertEnabled();
    const result = await repairService.downloadRetryBatch({
      userId: req.user?._id,
      repairId: req.params.repairId,
      batchId: req.params.batchId,
    });
    setAuditMetrics(res, { retryBatchId: result.batch?._id });
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.content);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

module.exports = {
  applyMisaImportRepairBulk: auditedHandler("bulk_apply", applyMisaImportRepairBulk),
  confirmMisaImportRepairMatch: auditedHandler("confirm_match", confirmMisaImportRepairMatch),
  createMisaImportRetryBatch: auditedHandler("retry_create", createMisaImportRetryBatch),
  createMisaImportRepair: auditedHandler("create", createMisaImportRepair),
  downloadMisaImportRetryBatch: auditedHandler("retry_download", downloadMisaImportRetryBatch),
  issueMisaImportRepairHumanConfirmation: auditedHandler("confirmation_issue", issueMisaImportRepairHumanConfirmation),
  readMisaImportRepair: auditedHandler("read", readMisaImportRepair),
  resolveMisaImportRepairIssue: auditedHandler("issue_resolve", resolveMisaImportRepairIssue),
  setMisaImportRepairImportStatus: auditedHandler("import_status", setMisaImportRepairImportStatus),
  simulateMisaImportRepairBulk: auditedHandler("bulk_simulate", simulateMisaImportRepairBulk),
  submitMisaImportRepairSchema: auditedHandler("schema", submitMisaImportRepairSchema),
  extractMisaImportRepairAuditMetrics,
};
