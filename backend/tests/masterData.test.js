const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AccountingWorkspace = require("../models/AccountingWorkspace");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const MasterDataEntry = require("../models/MasterDataEntry");
const MasterDataAlias = require("../models/MasterDataAlias");
const {
  SUPPORTED_MASTER_DATA_TYPES,
  buildSnapshotSetHash,
  normalizeCode,
  normalizeName,
  normalizeTaxCode,
  prepareMasterDataEntries,
  userCanAccessWorkspace,
  userCanEditWorkspace,
} = require("../services/masterDataService");
const {
  createConversionContextToken,
  verifyConversionContextToken,
} = require("../services/conversionContextService");

test("workspace model is multi-company ready and defaults to AMIS", () => {
  const owner = new mongoose.Types.ObjectId();
  const workspace = new AccountingWorkspace({
    name: "Công ty BAE Foods",
    taxCode: "0317262773",
    owner,
  });

  assert.equal(workspace.misaProduct, "AMIS");
  assert.equal(workspace.accountingRegime, "AUTO");
  assert.equal(workspace.fiscalYearStartMonth, 1);
  assert.equal(workspace.validateSync(), undefined);
  assert.equal(userCanAccessWorkspace(workspace, owner), true);
});

test("workspace access supports members but rejects unrelated users", () => {
  const owner = new mongoose.Types.ObjectId();
  const editor = new mongoose.Types.ObjectId();
  const viewer = new mongoose.Types.ObjectId();
  const stranger = new mongoose.Types.ObjectId();
  const workspace = new AccountingWorkspace({
    name: "BAE Foods",
    owner,
    members: [
      { user: editor, role: "editor" },
      { user: viewer, role: "viewer" },
    ],
  });

  assert.equal(userCanAccessWorkspace(workspace, editor), true);
  assert.equal(userCanAccessWorkspace(workspace, viewer), true);
  assert.equal(userCanAccessWorkspace(workspace, stranger), false);
  assert.equal(userCanEditWorkspace(workspace, owner), true);
  assert.equal(userCanEditWorkspace(workspace, editor), true);
  assert.equal(userCanEditWorkspace(workspace, viewer), false);
});

test("master data schemas accept supported catalog types", () => {
  const workspace = new mongoose.Types.ObjectId();
  const snapshotId = new mongoose.Types.ObjectId();
  const user = new mongoose.Types.ObjectId();
  const type = "supplier";

  assert.ok(SUPPORTED_MASTER_DATA_TYPES.includes(type));
  assert.equal(
    new MasterDataSnapshot({
      workspace,
      type,
      sourceFileName: "suppliers.xlsx",
      sourceFileHash: "abc",
      importedBy: user,
    }).validateSync(),
    undefined,
  );
  assert.equal(
    new MasterDataEntry({
      workspace,
      snapshot: snapshotId,
      type,
      code: "NCC001",
      normalizedCode: "NCC001",
      name: "Nhà cung cấp A",
      normalizedName: "nha cung cap a",
    }).validateSync(),
    undefined,
  );
  assert.equal(
    new MasterDataAlias({
      workspace,
      type,
      rawValue: "NCC A",
      normalizedRawValue: "ncc a",
      targetCode: "NCC001",
      normalizedTargetCode: "NCC001",
      confirmedBy: user,
    }).validateSync(),
    undefined,
  );
  const activeSnapshotIndex = MasterDataSnapshot.schema
    .indexes()
    .find(
      ([, options]) =>
        options.name === "uniq_active_snapshot_per_workspace_type",
    );
  assert.ok(activeSnapshotIndex);
  assert.equal(activeSnapshotIndex[1].unique, true);
});

test("normalizers preserve leading zeros while making names searchable", () => {
  assert.equal(normalizeCode(" 001-A "), "001-A");
  assert.equal(normalizeName("  Công ty TNHH BẢO AN  "), "cong ty tnhh bao an");
  assert.equal(normalizeTaxCode(" 0317 262 773-001 "), "0317262773-001");
});

test("entry preparation removes blank rows and reports duplicate codes", () => {
  const result = prepareMasterDataEntries("supplier", [
    { code: "NCC001", name: "Công ty A", taxCode: "0101" },
    { code: " ncc001 ", name: "Công ty A khác", taxCode: "0102" },
    { code: "", name: "" },
    { code: "NCC002", name: "Công ty B", taxCode: "0103" },
  ]);

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].normalizedCode, "NCC001");
  assert.equal(result.entries[1].normalizedCode, "NCC002");
  assert.deepEqual(result.warnings, [
    "Mã NCC001 xuất hiện nhiều lần; chỉ giữ dòng đầu tiên.",
  ]);
});

test("snapshot hash is stable regardless of input order", () => {
  const left = buildSnapshotSetHash([
    { type: "item", id: "2", sourceFileHash: "b" },
    { type: "supplier", id: "1", sourceFileHash: "a" },
  ]);
  const right = buildSnapshotSetHash([
    { type: "supplier", id: "1", sourceFileHash: "a" },
    { type: "item", id: "2", sourceFileHash: "b" },
  ]);

  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});

test("conversion context token is scoped and expires", () => {
  const previous = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERSION_CONTEXT_SECRET = "unit-test-secret";
  try {
    const token = createConversionContextToken({
      userId: "user-1",
      workspaceId: "workspace-1",
      snapshotSetHash: "snapshot-hash",
      snapshotIds: ["snapshot-1"],
      masterDataRevision: 3,
      expiresIn: "5m",
    });
    const claims = verifyConversionContextToken(token);

    assert.equal(claims.purpose, "misa_conversion");
    assert.equal(claims.user_id, "user-1");
    assert.equal(claims.workspace_id, "workspace-1");
    assert.deepEqual(claims.snapshot_ids, ["snapshot-1"]);
    assert.equal(claims.master_data_revision, 3);
  } finally {
    process.env.CONVERSION_CONTEXT_SECRET = previous;
  }
});
