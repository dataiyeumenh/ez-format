const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanReconstructionProfilePayload,
  serializeReconstructionProfile,
} = require("../services/reconstructionProfileService");

test("reconstruction profile keeps structural rules and rejects transaction values", () => {
  const payload = cleanReconstructionProfilePayload({
    name: " File hóa đơn mua vào ",
    sourceSignatureHash: "abc",
    directionScope: "purchase",
    compatibleHeaderFingerprint: "headers",
    groupingKeys: ["supplier_tax_code", "invoice_symbol", "invoice_number"],
    fillDownFields: ["invoice_number", "invoice_date"],
    fieldRoles: { "Số HĐ": "invoice_number" },
    classificationRules: { "Phân loại": { "Hàng hóa": "goods" } },
    templateRouting: { goods: "purchase_goods", service: "purchase_service" },
    transactionValues: [{ amount: 1000000 }],
  });

  assert.equal(payload.name, "File hóa đơn mua vào");
  assert.deepEqual(payload.groupingKeys, [
    "supplier_tax_code",
    "invoice_symbol",
    "invoice_number",
  ]);
  assert.equal(payload.transactionValues, undefined);
});

test("reconstruction profile serializer includes immutable version metadata", () => {
  const profile = {
    _id: "profile-1",
    workspace: "workspace-1",
    name: "Purchase source",
    sourceSignatureHash: "signature",
    compatibleHeaderFingerprint: "headers",
    directionScope: "purchase",
    status: "active",
    version: 3,
    groupingKeys: [],
    fillDownFields: [],
    fieldRoles: {},
    mapping: {},
    defaults: {},
    formulas: {},
    classificationRules: {},
    templateRouting: {},
    usageCount: 4,
    successCount: 3,
    reviewCount: 1,
  };

  const payload = serializeReconstructionProfile(profile);
  assert.equal(payload.version, 3);
  assert.equal(payload.status, "active");
  assert.equal(payload.metrics.reviewCount, 1);
});
