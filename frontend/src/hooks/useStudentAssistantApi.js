import { useCallback } from "react";
import api from "../services/api";

const viteEnv = import.meta.env || {};
const pythonBaseURL = viteEnv.VITE_PYTHON_API_URL
  ? `${viteEnv.VITE_PYTHON_API_URL}`.replace(/\/+$/, "")
  : "/python-api";

export const studentAssistantEnabled =
  String(viteEnv.VITE_STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() ===
    "true" &&
  String(viteEnv.VITE_STUDENT_FILE_EXPLAIN_ENABLED || "false").toLowerCase() ===
    "true";
export const studentFileQaEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_FILE_QA_ENABLED || "false").toLowerCase() === "true";
export const studentCheckWorkEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_CHECK_WORK_ENABLED || "false").toLowerCase() === "true";
export const studentAccountingMapEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_ACCOUNTING_MAP_ENABLED || "false").toLowerCase() === "true";
export const studentReconciliationEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_RECONCILIATION_ENABLED || "false").toLowerCase() === "true";
export const studentInternshipEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_INTERNSHIP_ENABLED || "false").toLowerCase() === "true";

export const STUDENT_TEMPLATE_OPTIONS = [
  { id: "bsn_sales", label: "BSN - Bán hàng" },
  { id: "bsn_purchase", label: "BSN - Mua hàng" },
  { id: "misa_purchase_domestic", label: "MISA - Mua hàng trong nước" },
  { id: "sales_goods", label: "Bán hàng hóa" },
  { id: "sales_service", label: "Bán dịch vụ" },
  { id: "purchase_goods", label: "Mua hàng hóa" },
  { id: "purchase_service", label: "Mua dịch vụ" },
];

async function readJsonResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.detail || payload.message || fallback);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function extensionFromFile(file) {
  const match = String(file?.name || "").match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

export async function fetchStudentAssistantStatus(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${pythonBaseURL}/healthz`, {
      cache: "no-store",
    });
    if (!response.ok) return { serviceOnline: false, aiStatus: null };
    const payload = await response.json();
    return {
      serviceOnline: payload?.status === "ok",
      aiStatus: payload?.ai || "disabled",
      capabilityEnabled: Boolean(
        payload?.capabilities?.studentAssistant &&
          payload?.capabilities?.studentFileExplain,
      ),
      questionCapabilityEnabled: Boolean(payload?.capabilities?.studentFileQa),
      attemptCapabilityEnabled: Boolean(payload?.capabilities?.studentCheckWork),
      accountingMapCapabilityEnabled: Boolean(payload?.capabilities?.studentAccountingMap),
      reconciliationCapabilityEnabled: Boolean(payload?.capabilities?.studentReconciliation),
      internshipCapabilityEnabled: Boolean(payload?.capabilities?.studentInternship),
    };
  } catch {
    return { serviceOnline: false, aiStatus: null, capabilityEnabled: false };
  }
}

export function useStudentAssistantApi() {
  const createSession = useCallback(async (file, workspaceId = null) => {
    try {
      const response = await api.post("/student/sessions", {
        workspaceId: workspaceId || undefined,
        file: {
          originalName: file.name,
          sizeBytes: file.size,
          extension: extensionFromFile(file),
          contentHash: "",
        },
      });
      return response.data;
    } catch (error) {
      const wrapped = new Error(
        error.response?.data?.message || "Không thể tạo phiên giải thích file.",
      );
      wrapped.status = error.response?.status;
      wrapped.payload = error.response?.data;
      throw wrapped;
    }
  }, []);

  const analyzeSession = useCallback(async (file, contextToken, targetTemplateId) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("context_token", contextToken);
    if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
    const response = await fetch(`${pythonBaseURL}/api/v1/student/sessions/analyze`, {
      method: "POST",
      body: formData,
    });
    return readJsonResponse(response, "Không thể phân tích file cho chế độ sinh viên.");
  }, []);

  const getOverview = useCallback(async (sessionId, contextToken) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/overview`,
      { headers: { "X-Student-Context": contextToken }, cache: "no-store" },
    );
    return readJsonResponse(response, "Không thể tải lại phần giải thích file.");
  }, []);

  const refreshContext = useCallback(async (sessionId) => {
    try {
      const response = await api.post(
        `/student/sessions/${encodeURIComponent(sessionId)}/context`,
      );
      return response.data;
    } catch (error) {
      const wrapped = new Error(
        error.response?.data?.message || "Không thể làm mới phiên giải thích file.",
      );
      wrapped.status = error.response?.status;
      wrapped.payload = error.response?.data;
      throw wrapped;
    }
  }, []);

  const askQuestion = useCallback(async (sessionId, contextToken, question) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/questions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Student-Context": contextToken,
        },
        body: JSON.stringify({ question }),
      },
    );
    return readJsonResponse(response, "Không thể trả lời câu hỏi về file này.");
  }, []);

  const getSourceRow = useCallback(async (sessionId, contextToken, worksheetRow, signal) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/source-rows/${encodeURIComponent(worksheetRow)}`,
      {
        headers: { "X-Student-Context": contextToken },
        cache: "no-store",
        signal,
      },
    );
    return readJsonResponse(response, "Không thể tải dòng nguồn được chọn.");
  }, []);

  const submitAttempt = useCallback(async (sessionId, contextToken, request) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/attempts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Student-Context": contextToken,
        },
        body: JSON.stringify(request),
      },
    );
    return readJsonResponse(response, "Không thể kiểm tra bài làm hiện tại.");
  }, []);

  const revealHint = useCallback(
    async (sessionId, contextToken, attemptId, issueId, level) => {
      const response = await fetch(
        `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/attempts/${encodeURIComponent(attemptId)}/hints/${encodeURIComponent(level)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Student-Context": contextToken,
          },
          body: JSON.stringify({ issue_id: issueId }),
        },
      );
      return readJsonResponse(response, "Không thể mở gợi ý này.");
    },
    [],
  );

  const getAttemptHistory = useCallback(async (sessionId, contextToken) => {
    const response = await api.get(
      `/student/sessions/${encodeURIComponent(sessionId)}/attempts`,
      { headers: { "X-Student-Context": contextToken } },
    );
    return response.data;
  }, []);

  const getSkillProgress = useCallback(async () => {
    const response = await api.get("/student/progress");
    return response.data;
  }, []);

  const getAccountingMap = useCallback(async (sessionId, contextToken) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/accounting-map`,
      { headers: { "X-Student-Context": contextToken }, cache: "no-store" },
    );
    return readJsonResponse(response, "Không thể tải sơ đồ hạch toán.");
  }, []);

  const getReconciliation = useCallback(async (sessionId, contextToken) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/reconciliation`,
      { headers: { "X-Student-Context": contextToken }, cache: "no-store" },
    );
    return readJsonResponse(response, "Không thể tải kết quả đối chiếu.");
  }, []);

  const previewAnonymization = useCallback(async (sessionId, contextToken, fullDocumentNumbers) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/anonymization/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Student-Context": contextToken },
        body: JSON.stringify({ full_document_numbers: Boolean(fullDocumentNumbers) }),
      },
    );
    return readJsonResponse(response, "Không thể xem trước bản ẩn danh.");
  }, []);

  const exportAnonymizedWorkbook = useCallback(async (sessionId, contextToken, fullDocumentNumbers) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/anonymization/export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Student-Context": contextToken },
        body: JSON.stringify({ full_document_numbers: Boolean(fullDocumentNumbers) }),
      },
    );
    if (!response.ok) await readJsonResponse(response, "Không thể xuất workbook ẩn danh.");
    return { blob: await response.blob(), filename: "student-anonymized.xlsx" };
  }, []);

  const getActivities = useCallback(async (sessionId, contextToken) => {
    const response = await api.get(`/student/sessions/${encodeURIComponent(sessionId)}/activity`, {
      headers: { "X-Student-Context": contextToken },
    });
    return response.data;
  }, []);

  const deleteActivities = useCallback(async (sessionId, contextToken) => {
    const response = await api.delete(`/student/sessions/${encodeURIComponent(sessionId)}/activity`, {
      headers: { "X-Student-Context": contextToken },
    });
    return response.data;
  }, []);

  const generateInternshipReport = useCallback(async (sessionId, contextToken, request) => {
    const response = await fetch(
      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/internship-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Student-Context": contextToken },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) await readJsonResponse(response, "Không thể tạo báo cáo bàn giao.");
    return { blob: await response.blob(), filename: "internship-handoff.md" };
  }, []);

  return {
    createSession,
    analyzeSession,
    getOverview,
    refreshContext,
    askQuestion,
    getSourceRow,
    submitAttempt,
    revealHint,
    getAttemptHistory,
    getSkillProgress,
    getAccountingMap,
    getReconciliation,
    previewAnonymization,
    exportAnonymizedWorkbook,
    getActivities,
    deleteActivities,
    generateInternshipReport,
  };
}
