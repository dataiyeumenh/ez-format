const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const ConversionRun = require("../models/ConversionRun");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const { createConversionContextToken } = require("./conversionContextService");
const { STALE_PROCESSING_MS } = require("./conversionRunService");
const {
  buildSnapshotSetHash,
  userCanAccessWorkspace,
} = require("./masterDataService");

function bindingError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function issueConversionContextForRun({
  conversionRunId,
  userId,
  expectedWorkspaceId = null,
  now = new Date(),
  models = {},
}) {
  const normalizedRunId = String(conversionRunId || "").trim();
  const normalizedUserId = String(userId || "").trim();
  if (
    !mongoose.isValidObjectId(normalizedRunId) ||
    !mongoose.isValidObjectId(normalizedUserId)
  ) {
    return null;
  }
  const Run = models.ConversionRun || ConversionRun;
  const Workspace = models.AccountingWorkspace || AccountingWorkspace;
  const Snapshot = models.MasterDataSnapshot || MasterDataSnapshot;
  const run = await Run.findOne({
    _id: normalizedRunId,
    user: normalizedUserId,
    status: "processing",
    mode: "mapping",
    startedAt: { $gt: new Date(now.getTime() - STALE_PROCESSING_MS) },
  });
  if (!run) return null;

  const operationSessionId = String(run.operationSessionId || "").trim();
  const uploadId = String(run.converterUploadId || "").trim();
  const targetTemplateId = String(run.targetTemplateId || "").trim();
  if (!operationSessionId || !uploadId || !targetTemplateId) {
    throw bindingError(409, "Conversion run thiếu binding production");
  }

  const runWorkspaceId = run.workspace ? String(run.workspace._id || run.workspace) : null;
  const normalizedExpectedWorkspaceId = expectedWorkspaceId
    ? String(expectedWorkspaceId).trim()
    : null;
  if (
    normalizedExpectedWorkspaceId &&
    normalizedExpectedWorkspaceId !== runWorkspaceId
  ) {
    return null;
  }

  let workspace = null;
  let snapshots = [];
  let snapshotSetHash = null;
  let masterDataRevision = 0;
  if (runWorkspaceId) {
    workspace = await Workspace.findOne({ _id: runWorkspaceId, isActive: true });
    if (!workspace || !userCanAccessWorkspace(workspace, normalizedUserId)) return null;
    const snapshotIds = (workspace.activeSnapshots || []).map((item) => item.snapshot);
    snapshots = await Snapshot.find({
      _id: { $in: snapshotIds },
      workspace: workspace._id,
      status: "active",
    });
    snapshotSetHash = buildSnapshotSetHash(snapshots);
    if (
      String(run.snapshotSetHash || "") &&
      String(run.snapshotSetHash) !== snapshotSetHash
    ) {
      throw bindingError(409, "Danh mục MISA đã thay đổi; vui lòng phân tích lại file");
    }
    masterDataRevision = Number(workspace.masterDataRevision || 0);
  }

  const contextToken = createConversionContextToken({
    userId: normalizedUserId,
    workspaceId: runWorkspaceId,
    snapshotSetHash,
    snapshotIds: snapshots.map((item) => item._id),
    masterDataRevision,
    conversionRunId: normalizedRunId,
    operationSessionId,
    uploadId,
    targetTemplateId,
    scopes: ["analyze", "preview", "readiness", "confirm", "export"],
  });

  return {
    contextToken,
    conversionRunId: normalizedRunId,
    operationSessionId,
    uploadId,
    targetTemplateId,
    snapshotSetHash,
    workspace,
    snapshots,
  };
}

module.exports = { issueConversionContextForRun };
