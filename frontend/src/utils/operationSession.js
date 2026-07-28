const DEFAULT_LIMITS = Object.freeze({
  comparison_files: 0,
  raw_ttl_minutes: 0,
  max_rows_per_file: 0,
});

export const DEFAULT_OPERATION_CAPABILITIES = Object.freeze({
  mapping_profile_v2: false,
  anomaly_detection: false,
  bulk_correction: false,
  reconciliation: false,
  accounting_assistant: false,
  ai_explanation: false,
  limits: DEFAULT_LIMITS,
});

const OPERATION_NAMES = ["anomaly", "correction", "reconciliation", "assistant"];

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function normalizeOperationCapabilities(payload) {
  const source = payload?.capabilities || payload;
  if (!source || typeof source !== "object") return DEFAULT_OPERATION_CAPABILITIES;
  return {
    mapping_profile_v2: source.mapping_profile_v2 === true,
    anomaly_detection: source.anomaly_detection === true,
    bulk_correction: source.bulk_correction === true,
    reconciliation: source.reconciliation === true,
    accounting_assistant: source.accounting_assistant === true,
    ai_explanation: source.ai_explanation === true,
    limits: {
      comparison_files: positiveInteger(source.limits?.comparison_files),
      raw_ttl_minutes: positiveInteger(source.limits?.raw_ttl_minutes),
      max_rows_per_file: positiveInteger(source.limits?.max_rows_per_file),
    },
  };
}

export function intersectOperationCapabilities(nodePayload, converterPayload) {
  const node = normalizeOperationCapabilities(nodePayload);
  const converter = normalizeOperationCapabilities(converterPayload);
  const limit = (name) => {
    const values = [node.limits[name], converter.limits[name]].filter(
      (value) => Number.isInteger(value) && value > 0,
    );
    return values.length === 2 ? Math.min(...values) : 0;
  };
  return {
    mapping_profile_v2: node.mapping_profile_v2 && converter.mapping_profile_v2,
    anomaly_detection: node.anomaly_detection && converter.anomaly_detection,
    bulk_correction: node.bulk_correction && converter.bulk_correction,
    reconciliation: node.reconciliation && converter.reconciliation,
    accounting_assistant: node.accounting_assistant && converter.accounting_assistant,
    ai_explanation: node.ai_explanation && converter.ai_explanation,
    limits: {
      comparison_files: limit("comparison_files"),
      raw_ttl_minutes: limit("raw_ttl_minutes"),
      max_rows_per_file: limit("max_rows_per_file"),
    },
  };
}

export function extractOperationSession(payload) {
  const source = payload?.session || payload;
  const sessionId = String(source?.session_id || "").trim();
  if (!sessionId) return null;
  const revision = Number(source.active_revision ?? source.revision ?? 0);
  return {
    sessionId,
    uploadId: String(source.upload_id || "").trim(),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    stateHash: String(source.state_hash || "").trim(),
    expiresAt: source.expires_at ? String(source.expires_at) : null,
  };
}

function emptyOperations() {
  return Object.fromEntries(OPERATION_NAMES.map((name) => [name, "idle"]));
}

function revisionChanged(previous, next) {
  return Boolean(
    previous &&
      next &&
      (previous.revision !== next.revision || previous.stateHash !== next.stateHash),
  );
}

function revisionReplacementResults(operation, payload) {
  const replacements = {};
  const supplied = payload?.results;
  if (supplied && typeof supplied === "object") {
    for (const name of OPERATION_NAMES) {
      if (Object.hasOwn(supplied, name)) replacements[name] = supplied[name];
    }
  }
  if (OPERATION_NAMES.includes(operation) && payload !== undefined) {
    replacements[operation] = payload;
  }
  return replacements;
}

function invalidateRevisionBoundState(state, session, replacements = {}) {
  const preservedResults = Object.fromEntries(
    Object.entries(state.results).filter(([name]) => !OPERATION_NAMES.includes(name)),
  );
  return {
    ...state,
    session,
    operations: { ...state.operations, ...emptyOperations() },
    results: { ...preservedResults, ...replacements },
    notice: state.notice?.kind === "stale_revision" ? state.notice : null,
    announcement: "",
  };
}

export function createOperationSessionState() {
  return {
    session: null,
    operations: emptyOperations(),
    results: {},
    notice: null,
    announcement: "",
  };
}

export function classifySessionError(error, { optional = false } = {}) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 409) return "stale_revision";
  if (status === 410) return "expired_session";
  if (status === 401 || status === 403) return "permission_denied";
  if (optional && (!status || status === 502 || status === 503 || status === 504)) {
    return "optional_service_offline";
  }
  return "request_error";
}

function mergeRevision(session, payload) {
  if (!session) return extractOperationSession(payload);
  const source = payload?.session || payload || {};
  const nextRevision = Number(source.active_revision ?? source.revision);
  return {
    ...session,
    revision:
      Number.isInteger(nextRevision) && nextRevision >= 0
        ? nextRevision
        : session.revision,
    stateHash: source.state_hash ? String(source.state_hash) : session.stateHash,
    expiresAt: source.expires_at ? String(source.expires_at) : session.expiresAt,
  };
}

export function buildStaleRecovery(expectedSessionId, payload) {
  const session = extractOperationSession(payload);
  const mutationContext = buildMutationContext(session);
  if (!session || !mutationContext || session.sessionId !== expectedSessionId) {
    return null;
  }
  return { session, mutationContext, syncPayload: payload };
}

export function operationSessionReducer(state, action) {
  switch (action.type) {
    case "analysis_ready":
      return {
        ...createOperationSessionState(),
        session: extractOperationSession(action.payload),
      };
    case "operation_started":
      return {
        ...state,
        operations: { ...state.operations, [action.operation]: "loading" },
        notice: null,
        announcement: "",
      };
    case "operation_succeeded": { 
      const session = mergeRevision(state.session, action.payload);
      const next = revisionChanged(state.session, session)
        ? invalidateRevisionBoundState(
            state,
            session,
            revisionReplacementResults(action.operation, action.payload),
          )
        : state;
      return {
        ...next,
        session,
        operations: { ...next.operations, [action.operation]: "success" },
        results: revisionChanged(state.session, session)
          ? next.results
          : { ...state.results, [action.operation]: action.payload },
        notice:
          revisionChanged(state.session, session) &&
          state.notice?.kind === "stale_revision"
            ? state.notice
            : null,
        announcement: action.announcement || "Thao tác đã hoàn tất.",
      };
    }
    case "session_synced": { 
      const session = mergeRevision(state.session, action.payload);
      if (revisionChanged(state.session, session)) {
        return invalidateRevisionBoundState(
          state,
          session,
          revisionReplacementResults(null, action.payload),
        );
      }
      return {
        ...state,
        session,
      };
    }
    case "operation_failed": {
      const kind = classifySessionError(action.error, {
        optional: action.optional === true,
      });
      return {
        ...state,
        operations: { ...state.operations, [action.operation]: "error" },
        notice: {
          kind,
          message: action.error?.message || "Không thể hoàn tất thao tác.",
        },
        announcement: "",
      };
    }
    case "mark_stale":
      return {
        ...state,
        notice: {
          kind: "stale_revision",
          message: action.message || "Dữ liệu đã thay đổi. Vui lòng tải lại kết quả.",
        },
      };
    case "clear_notice":
      return { ...state, notice: null };
    case "reset":
      return createOperationSessionState();
    default:
      return state;
  }
}

export function buildMutationContext(session) {
  if (
    !String(session?.stateHash || "").trim() ||
    !Number.isInteger(session?.revision)
  ) {
    return null;
  }
  return {
    revision: session.revision,
    state_hash: session.stateHash,
  };
}

export function getConverterSteps(capabilities = DEFAULT_OPERATION_CAPABILITIES) {
  const steps = ["Tải file", "Ghép cột", "Kiểm tra lỗi"];
  if (capabilities.reconciliation === true) steps.push("Đối chiếu");
  steps.push("Tải MISA");
  return steps;
}
