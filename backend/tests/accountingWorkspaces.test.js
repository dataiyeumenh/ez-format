const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  cleanWorkspacePayload,
  serializeSnapshot,
  serializeWorkspace,
} = require("../controllers/accountingWorkspaceController");
const { buildMasterDataContext } = require("../services/masterDataService");

test("workspace payload keeps only supported fields", () => {
  assert.deepEqual(
    cleanWorkspacePayload({
      name: "  BAE Foods  ",
      taxCode: " 0317262773 ",
      misaProduct: "SME",
      accountingRegime: "TT99",
      fiscalYearStartMonth: 4,
      owner: "must-not-pass",
      members: ["must-not-pass"],
    }),
    {
      name: "BAE Foods",
      taxCode: "0317262773",
      misaProduct: "SME",
      accountingRegime: "TT99",
      fiscalYearStartMonth: 4,
    },
  );
});

test("workspace serializer exposes active snapshot summary", () => {
  const workspace = {
    _id: new mongoose.Types.ObjectId(),
    name: "BAE Foods",
    taxCode: "0317262773",
    misaProduct: "AMIS",
    accountingRegime: "AUTO",
    fiscalYearStartMonth: 1,
    lockedThroughDate: null,
    owner: new mongoose.Types.ObjectId(),
    members: [],
    activeSnapshots: [
      { type: "supplier", snapshot: new mongoose.Types.ObjectId() },
    ],
    isActive: true,
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
    updatedAt: new Date("2026-07-13T01:00:00.000Z"),
  };

  const payload = serializeWorkspace(workspace);
  assert.equal(payload.name, "BAE Foods");
  assert.equal(payload.activeSnapshots.length, 1);
  assert.equal(payload.activeSnapshots[0].type, "supplier");
  assert.equal(payload.owner, String(workspace.owner));
});

test("snapshot serializer omits internal mongoose state", () => {
  const snapshot = {
    _id: new mongoose.Types.ObjectId(),
    type: "item",
    sourceFileName: "items.xlsx",
    sourceFileHash: "abc",
    rowCount: 12,
    status: "active",
    warnings: ["warning"],
    importedAt: new Date("2026-07-13T00:00:00.000Z"),
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
    updatedAt: new Date("2026-07-13T00:00:00.000Z"),
  };

  assert.deepEqual(serializeSnapshot(snapshot), {
    id: String(snapshot._id),
    type: "item",
    sourceFileName: "items.xlsx",
    sourceFileHash: "abc",
    rowCount: 12,
    status: "active",
    warnings: ["warning"],
    errorMessage: "",
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    activatedAt: null,
  });
});

test("master data context groups entries and aliases by type", () => {
  const context = buildMasterDataContext({
    workspace: { _id: "workspace-1", name: "BAE" },
    snapshots: [
      { _id: "snapshot-1", type: "supplier", sourceFileHash: "hash" },
    ],
    entries: [
      {
        type: "supplier",
        code: "NCC001",
        normalizedCode: "NCC001",
        name: "BAE",
      },
    ],
    aliases: [
      {
        type: "supplier",
        normalizedRawValue: "bae food",
        targetCode: "NCC001",
      },
    ],
  });

  assert.equal(context.workspace.id, "workspace-1");
  assert.equal(context.catalogs.supplier.entries.length, 1);
  assert.equal(context.catalogs.supplier.aliases.length, 1);
});
