const crypto = require("node:crypto");

function manifestError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "MANIFEST_BINDING_MISMATCH";
  return error;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function isUniqueTextArray(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
}

function sameStringSet(left, right) {
  return left.length === right.length &&
    left.every((value) => right.includes(value));
}

function validateRowGroupGraph(manifest) {
  if (manifest.rows.length === 0 || manifest.document_groups.length === 0) {
    throw manifestError("Manifest không có provenance rows");
  }
  const rowIds = new Set();
  const rowsByGroup = new Map();
  manifest.rows.forEach((row, index) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.export_row_id !== "string" ||
      !row.export_row_id ||
      rowIds.has(row.export_row_id) ||
      row.output_row_number !== index + 1 ||
      typeof row.document_group_id !== "string" ||
      !row.document_group_id ||
      !isUniqueTextArray(row.raw_row_ids) ||
      !row.locator ||
      typeof row.locator !== "object" ||
      Array.isArray(row.locator) ||
      !isSha256(row.line_fingerprint)
    ) {
      throw manifestError("Manifest row graph không hợp lệ");
    }
    rowIds.add(row.export_row_id);
    const grouped = rowsByGroup.get(row.document_group_id) || [];
    grouped.push(row);
    rowsByGroup.set(row.document_group_id, grouped);
  });

  const groupIds = new Set();
  const coveredRows = new Set();
  for (const group of manifest.document_groups) {
    const groupId = String(group?.document_group_id || "");
    const members = rowsByGroup.get(groupId);
    if (
      !groupId ||
      groupIds.has(groupId) ||
      !members ||
      !Array.isArray(group.output_row_numbers) ||
      group.output_row_numbers.length !== members.length ||
      new Set(group.output_row_numbers).size !== group.output_row_numbers.length ||
      group.line_count !== members.length ||
      !isUniqueTextArray(group.raw_row_ids)
    ) {
      throw manifestError("Manifest document group không hợp lệ");
    }
    const expectedRows = members.map((row) => row.output_row_number);
    if (!sameStringSet(group.output_row_numbers, expectedRows)) {
      throw manifestError("Manifest document group không khớp rows");
    }
    const expectedRawRows = [...new Set(members.flatMap((row) => row.raw_row_ids))];
    if (!sameStringSet(group.raw_row_ids, expectedRawRows)) {
      throw manifestError("Manifest document group không khớp provenance");
    }
    for (const rowNumber of group.output_row_numbers) {
      if (coveredRows.has(rowNumber)) {
        throw manifestError("Manifest document group bị trùng rows");
      }
      coveredRows.add(rowNumber);
    }
    groupIds.add(groupId);
  }
  if (groupIds.size !== rowsByGroup.size || coveredRows.size !== manifest.rows.length) {
    throw manifestError("Manifest document group thiếu rows");
  }
}

function validateManifestBinding(manifest, binding) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw manifestError("Manifest không hợp lệ");
  }
  if (
    manifest.schema_version !== 1 ||
    manifest.misa_product !== "SME" ||
    manifest.conversion_id !== binding.conversionRunId ||
    manifest.export_batch_id !== binding.exportBatchId ||
    manifest.target_template_id !== binding.targetTemplateId ||
    !isSha256(manifest.template_hash) ||
    !isSha256(manifest.raw_file_hash) ||
    typeof manifest.mapping_profile_id !== "string" ||
    !manifest.mapping_profile_id ||
    !Number.isSafeInteger(manifest.mapping_profile_version) ||
    manifest.mapping_profile_version < 0 ||
    !Array.isArray(manifest.rows) ||
    !Array.isArray(manifest.document_groups)
  ) {
    throw manifestError("Manifest không khớp conversion run");
  }
  if (
    (binding.rawFileHash && manifest.raw_file_hash !== binding.rawFileHash) ||
    (binding.mappingProfileId && manifest.mapping_profile_id !== binding.mappingProfileId) ||
    (binding.mappingProfileVersion != null &&
      manifest.mapping_profile_version !== Number(binding.mappingProfileVersion)) ||
    (binding.mappingProfileStateHash != null &&
      String(manifest.mapping_profile_state_hash || "") !==
        String(binding.mappingProfileStateHash || ""))
  ) {
    throw manifestError("Manifest không khớp trusted conversion state");
  }
  validateRowGroupGraph(manifest);
  return manifest;
}

function manifestArtifact(manifest) {
  const content = Buffer.from(JSON.stringify(manifest), "utf8");
  return {
    content,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

module.exports = { manifestArtifact, validateManifestBinding };
