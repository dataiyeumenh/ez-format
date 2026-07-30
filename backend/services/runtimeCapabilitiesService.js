const FEATURE_KEYS = Object.freeze({
  mapping_profile_v2: "FEATURE_MAPPING_PROFILE_V2",
  anomaly_detection: "FEATURE_ANOMALY_DETECTION",
  bulk_correction: "FEATURE_BULK_CORRECTION",
  reconciliation: "FEATURE_RECONCILIATION",
  accounting_assistant: "FEATURE_ACCOUNTING_ASSISTANT",
  ai_explanation: "FEATURE_AI_EXPLANATION",
});

function parseFeatureFlag(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function getRuntimeCapabilities(env = process.env) {
  const capabilities = Object.fromEntries(
    Object.entries(FEATURE_KEYS).map(([name, envKey]) => [
      name,
      parseFeatureFlag(env[envKey]),
    ]),
  );
  capabilities.limits = {
    comparison_files: boundedInteger(
      env.ACCOUNTING_COMPARISON_FILE_LIMIT,
      2,
      0,
      2,
    ),
    raw_ttl_minutes: boundedInteger(
      env.ACCOUNTING_RAW_TTL_MINUTES,
      60,
      5,
      24 * 60,
    ),
    max_rows_per_file: boundedInteger(
      env.ACCOUNTING_MAX_ROWS_PER_FILE,
      50000,
      100,
      100000,
    ),
  };
  return capabilities;
}

module.exports = {
  FEATURE_KEYS,
  getRuntimeCapabilities,
  parseFeatureFlag,
};
