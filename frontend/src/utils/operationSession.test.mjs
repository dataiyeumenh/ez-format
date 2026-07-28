import assert from "node:assert/strict";
import test from "node:test";
import * as operationSession from "./operationSession.js";

import {
  DEFAULT_OPERATION_CAPABILITIES,
  buildMutationContext,
  classifySessionError,
  createOperationSessionState,
  extractOperationSession,
  getConverterSteps,
  normalizeOperationCapabilities,
  operationSessionReducer,
} from "./operationSession.js";

test("capabilities fail closed and normalize backend limits", () => {
  assert.deepEqual(
    normalizeOperationCapabilities(null),
    DEFAULT_OPERATION_CAPABILITIES,
  );

  const capabilities = normalizeOperationCapabilities({
    capabilities: {
      mapping_profile_v2: true,
      anomaly_detection: 1,
      bulk_correction: true,
      reconciliation: true,
      accounting_assistant: true,
      ai_explanation: false,
      limits: {
        comparison_files: 2,
        raw_ttl_minutes: 60,
        max_rows_per_file: 50000,
      },
    },
  });

  assert.equal(capabilities.mapping_profile_v2, true);
  assert.equal(capabilities.anomaly_detection, false);
  assert.equal(capabilities.limits.comparison_files, 2);
  assert.equal(capabilities.limits.max_rows_per_file, 50000);
});

test("session extraction accepts the normalized contract without guessing legacy IDs", () => {
  const session = extractOperationSession({
    session: {
      session_id: "session-1",
      upload_id: "upload-1",
      active_revision: 3,
      state_hash: "sha256:state-3",
      expires_at: "2026-07-27T10:00:00Z",
    },
  });

  assert.deepEqual(session, {
    sessionId: "session-1",
    uploadId: "upload-1",
    revision: 3,
    stateHash: "sha256:state-3",
    expiresAt: "2026-07-27T10:00:00Z",
  });
  assert.equal(extractOperationSession({ upload_id: "legacy-upload" }), null);
});

test("session reducer binds successful mutations to the newest revision", () => {
  const initial = createOperationSessionState();
  const analyzed = operationSessionReducer(initial, {
    type: "analysis_ready",
    payload: {
      session_id: "session-1",
      upload_id: "upload-1",
      active_revision: 1,
      state_hash: "state-1",
    },
  });
  const loading = operationSessionReducer(analyzed, {
    type: "operation_started",
    operation: "correction",
  });
  const applied = operationSessionReducer(loading, {
    type: "operation_succeeded",
    operation: "correction",
    payload: { revision: 2, state_hash: "state-2", patch_set_id: "patch-1" },
  });

  assert.equal(loading.operations.correction, "loading");
  assert.equal(applied.operations.correction, "success");
  assert.equal(applied.session.revision, 2);
  assert.equal(applied.session.stateHash, "state-2");
  assert.equal(applied.results.correction.patch_set_id, "patch-1");
  assert.deepEqual(buildMutationContext(applied.session), {
    revision: 2,
    state_hash: "state-2",
  });
  assert.equal(
    buildMutationContext({ sessionId: "session-1", revision: 2, stateHash: "" }),
    null,
  );
});

test("session sync invalidates revision-bound state while retaining stale notice", () => {
  const state = {
    ...createOperationSessionState(),
    session: {
      sessionId: "session-1",
      uploadId: "upload-1",
      revision: 1,
      stateHash: "state-1",
      expiresAt: null,
    },
    operations: {
      anomaly: "success",
      correction: "success",
      reconciliation: "success",
      assistant: "success",
    },
    results: {
      anomaly: { issues: [] },
      correction: { preview: [] },
      reconciliation: { report_id: "report-1" },
      assistant: { answer: "old answer" },
    },
    notice: { kind: "stale_revision", message: "Tải lại dữ liệu mới." },
  };
  const next = operationSessionReducer(state, {
    type: "session_synced",
    payload: {
      session: {
        session_id: "session-1",
        active_revision: 2,
        state_hash: "state-2",
      },
    },
  });
  assert.equal(next.session.revision, 2);
  assert.equal(next.session.stateHash, "state-2");
  assert.deepEqual(next.results, {});
  assert.deepEqual(next.operations, {
    anomaly: "idle",
    correction: "idle",
    reconciliation: "idle",
    assistant: "idle",
  });
  assert.deepEqual(next.notice, state.notice);
});

test("revision mutation retains only the supplied replacement result", () => {
  const state = {
    ...createOperationSessionState(),
    session: {
      sessionId: "session-1",
      uploadId: "upload-1",
      revision: 1,
      stateHash: "state-1",
      expiresAt: null,
    },
    results: {
      anomaly: { issues: [] },
      correction: { preview: ["old"] },
      reconciliation: { report_id: "report-1" },
      assistant: { answer: "old answer" },
    },
    notice: { kind: "stale_revision", message: "Tải lại dữ liệu mới." },
  };
  const payload = { revision: 2, state_hash: "state-2", preview: ["new"] };

  const next = operationSessionReducer(state, {
    type: "operation_succeeded",
    operation: "correction",
    payload,
  });

  assert.deepEqual(next.results, { correction: payload });
  assert.equal(next.operations.correction, "success");
  assert.equal(next.operations.anomaly, "idle");
  assert.equal(next.operations.reconciliation, "idle");
  assert.equal(next.operations.assistant, "idle");
  assert.deepEqual(next.notice, state.notice);
});

test("stale recovery only accepts a current revision for the active session", () => {
  assert.equal(typeof operationSession.buildStaleRecovery, "function");
  const payload = {
    session_id: "session-1",
    active_revision: 2,
    state_hash: "state-2",
    items: [{ revision: 2 }],
  };

  assert.deepEqual(
    operationSession.buildStaleRecovery("session-1", payload),
    {
      session: {
        sessionId: "session-1",
        uploadId: "",
        revision: 2,
        stateHash: "state-2",
        expiresAt: null,
      },
      mutationContext: { revision: 2, state_hash: "state-2" },
      syncPayload: payload,
    },
  );
  assert.equal(operationSession.buildStaleRecovery("other-session", payload), null);
});

test("stale, expired, permission and optional offline failures remain explicit", () => {
  assert.equal(classifySessionError({ status: 409 }), "stale_revision");
  assert.equal(classifySessionError({ status: 410 }), "expired_session");
  assert.equal(classifySessionError({ status: 403 }), "permission_denied");
  assert.equal(
    classifySessionError({ status: 503 }, { optional: true }),
    "optional_service_offline",
  );

  const failed = operationSessionReducer(createOperationSessionState(), {
    type: "operation_failed",
    operation: "reconciliation",
    error: { status: 409, message: "Phiên bản đã thay đổi" },
  });
  assert.equal(failed.operations.reconciliation, "error");
  assert.equal(failed.notice.kind, "stale_revision");
});

test("wizard stays unchanged with flags off and adds only optional reconciliation", () => {
  assert.deepEqual(getConverterSteps(DEFAULT_OPERATION_CAPABILITIES), [
    "Tải file",
    "Ghép cột",
    "Kiểm tra lỗi",
    "Tải MISA",
  ]);
  assert.deepEqual(
    getConverterSteps({ ...DEFAULT_OPERATION_CAPABILITIES, reconciliation: true }),
    ["Tải file", "Ghép cột", "Kiểm tra lỗi", "Đối chiếu", "Tải MISA"],
  );
});
