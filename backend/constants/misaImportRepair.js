const REPAIR_STATUSES = [
  "uploaded",
  "needs_schema_mapping",
  "needs_match_review",
  "ready_for_repair",
  "retry_blocked",
  "retry_ready",
  "retry_exported",
  "closed",
  "failed",
];

const MATCH_STATUSES = ["unmatched", "suggested", "ambiguous", "confirmed", "rejected"];
const IMPORT_STATUSES = ["unknown", "failed", "imported"];
const RETRY_STATUSES = ["pending", "validating", "blocked", "exporting", "completed", "failed", "expired"];
const RESOLUTION_STATUSES = ["unresolved", "resolved", "dismissed"];
const RESOLUTION_SCOPES = ["once", "profile_proposal", "master_data_proposal"];
const ARTIFACT_TYPES = ["precheck_result", "failed_rows", "unrecognized"];
const HUMAN_CONFIRMATION_ACTIONS = [
  "confirm_match",
  "set_import_status",
  "resolve_issue",
  "bulk_apply",
  "retry_export",
];

module.exports = {
  ARTIFACT_TYPES,
  HUMAN_CONFIRMATION_ACTIONS,
  IMPORT_STATUSES,
  MATCH_STATUSES,
  REPAIR_STATUSES,
  RESOLUTION_SCOPES,
  RESOLUTION_STATUSES,
  RETRY_STATUSES,
};
