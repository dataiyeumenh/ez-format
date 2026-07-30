const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const express = require("express");
const mongoose = require("mongoose");

const MappingProfileV2 = require("../models/MappingProfileV2");
const { internalRouter } = require("../routes/mappingProfilesV2");
const { createConversionContextToken } = require("../services/conversionContextService");
const { buildProfileKey, buildStateHash } = require("../services/mappingProfileV2Service");

function runPython(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python", ["-c", code], {
      cwd: path.resolve(__dirname, "../../converter"),
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (codeValue) => {
      if (codeValue !== 0) {
        reject(new Error(`Python contract probe failed (${codeValue}): ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

test("converter client and Node internal Mapping Profile V2 routes share one HTTP contract", async () => {
  const original = {
    find: MappingProfileV2.find,
    findOne: MappingProfileV2.findOne,
    findOneAndUpdate: MappingProfileV2.findOneAndUpdate,
  };
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  process.env.CONVERSION_CONTEXT_SECRET = "contract-context-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "contract-service-secret";

  const userId = new mongoose.Types.ObjectId().toString();
  const profileId = new mongoose.Types.ObjectId().toString();
  const identity = {
    sourceFamily: "invoice-puller",
    documentType: "purchase",
    headerFingerprint: "header-hash",
    dataShapeFingerprint: "shape-hash",
    targetTemplateId: "misa_purchase_domestic",
    targetTemplateVersion: "template-v1",
  };
  const profile = {
    _id: profileId,
    ownerScope: `user:${userId}`,
    user: userId,
    workspace: null,
    profileFamilyId: crypto.randomUUID(),
    version: 3,
    status: "active",
    name: "Mua vào",
    ...identity,
    mapping: { "Ma NCC": "Mã nhà cung cấp" },
    defaults: {},
    formulas: {},
    riskFlags: ["vat"],
    approvedBy: userId,
    confirmationCount: 0,
    confirmedExportIds: [],
  };
  profile.profileKey = buildProfileKey(profile);
  profile.stateHash = buildStateHash(profile);

  MappingProfileV2.find = async () => [profile];
  MappingProfileV2.findOne = async (filter) => (
    String(filter._id) === profileId && filter.ownerScope === profile.ownerScope
      ? profile
      : null
  );
  MappingProfileV2.findOneAndUpdate = async (filter, update) => {
    if (
      String(filter._id) !== profileId ||
      filter.ownerScope !== profile.ownerScope ||
      filter.version !== 3 ||
      filter.stateHash !== profile.stateHash ||
      profile.confirmedExportIds.includes(filter.confirmedExportIds.$ne)
    ) return null;
    profile.confirmedExportIds.push(update.$addToSet.confirmedExportIds);
    profile.confirmationCount += 1;
    return profile;
  };

  const probeApp = express();
  probeApp.use(express.json());
  probeApp.use("/api/internal/mapping-profiles/v2", internalRouter);
  const server = await new Promise((resolve) => {
    const listener = probeApp.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId: null,
      snapshotSetHash: null,
    });
    const address = server.address();
    const python = `
import json
from app.mapping_profile_v2 import MappingProfileIdentity, match_mapping_profile_v2, record_confirmed_export_v2
identity = MappingProfileIdentity(
    source_family="invoice-puller",
    document_type="purchase",
    normalized_header_fingerprint="header-hash",
    data_shape_fingerprint="shape-hash",
    target_template_id="misa_purchase_domestic",
    target_template_version="template-v1",
)
match = match_mapping_profile_v2(${JSON.stringify(contextToken)}, identity)
record_confirmed_export_v2(
    ${JSON.stringify(contextToken)},
    profile_id=${JSON.stringify(profileId)},
    version=3,
    upload_id="upload-contract",
    state_hash=match.profile.state_hash,
)
print(json.dumps({
    "tier": match.match_tier,
    "profile_id": match.profile.id,
    "profile_state_hash": match.profile.state_hash,
    "approval_state": match.approval_state,
    "approved_risk_flags": list(match.approved_risk_flags),
    "can_suggest": match.can_suggest,
}))
`;
    const output = await runPython(python, {
      ...process.env,
      PYTHONPATH: path.resolve(__dirname, "../../converter"),
      FEATURE_MAPPING_PROFILE_V2: "true",
      NODE_INTERNAL_API_URL: `http://127.0.0.1:${address.port}/api/internal`,
      CONVERTER_SERVICE_TOKEN: process.env.CONVERTER_SERVICE_TOKEN,
    });

    assert.deepEqual(JSON.parse(output), {
      tier: "exact",
      profile_id: profileId,
      profile_state_hash: profile.stateHash,
      approval_state: "approved",
      approved_risk_flags: ["vat"],
      can_suggest: true,
    });
    assert.equal(profile.confirmationCount, 1);
    assert.equal(profile.confirmedExportIds.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    MappingProfileV2.find = original.find;
    MappingProfileV2.findOne = original.findOne;
    MappingProfileV2.findOneAndUpdate = original.findOneAndUpdate;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
    if (previousServiceToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
  }
});
