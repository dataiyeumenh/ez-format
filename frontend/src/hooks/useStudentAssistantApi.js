import { useCallback } from "react";
import api from "../services/api";

const viteEnv = import.meta.env || {};

function gatewayRequestError(error, fallback) {
  const detail = error?.response?.data?.detail;
  const message =
    typeof detail === "string"
      ? detail
      : typeof detail?.message === "string"
        ? detail.message
        : fallback;
  const requestError = new Error(message);
  requestError.status = error?.response?.status || 0;
  return requestError;
}

export const studentAssistantEnabled =
  String(viteEnv.VITE_STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true" &&
  String(viteEnv.VITE_STUDENT_FILE_EXPLAIN_ENABLED || "false").toLowerCase() === "true";
export const studentFileQaEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_FILE_QA_ENABLED || "false").toLowerCase() === "true";
export const studentAccountingMapEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_ACCOUNTING_MAP_ENABLED || "false").toLowerCase() ===
    "true";
export const studentReconciliationEnabled =
  studentAssistantEnabled &&
  String(viteEnv.VITE_STUDENT_RECONCILIATION_ENABLED || "false").toLowerCase() ===
    "true";
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

function extensionFromFile(file) {
  const match = String(file?.name || "").match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

async function requestStudent(config, fallback) {
  try {
    const response = await api.request(config);
    return response.data;
  } catch (error) {
    throw gatewayRequestError(error, fallback);
  }
}

function studentOperationUrl(sessionId, operation) {
  return `/student/sessions/${encodeURIComponent(sessionId)}/operations/${operation}`;
}

export async function fetchStudentAssistantStatus(apiClient = api) {
  try {
    const response = await apiClient.get("/converter/capabilities");
    const payload = response.data;
    return {
      serviceOnline: true,
      aiStatus: payload?.ai || "disabled",
      capabilityEnabled: Boolean(
        payload?.capabilities?.studentAssistant &&
        payload?.capabilities?.studentFileExplain,
      ),
      questionCapabilityEnabled: Boolean(payload?.capabilities?.studentFileQa),
      accountingMapCapabilityEnabled: Boolean(
        payload?.capabilities?.studentAccountingMap,
      ),
      reconciliationCapabilityEnabled: Boolean(
        payload?.capabilities?.studentReconciliation,
      ),
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
      throw gatewayRequestError(error, "Không thể tạo phiên giải thích file.");
    }
  }, []);

  const analyzeSession = useCallback(async (file, contextToken, targetTemplateId, sessionId) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("context_token", contextToken);
    if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
    return requestStudent(
      { url: `/student/sessions/${encodeURIComponent(sessionId)}/analyze`, method: "POST", data: formData },
      "Không thể phân tích file cho chế độ sinh viên.",
    );
  }, []);

  const getOverview = useCallback(async (sessionId, contextToken) => {
    return requestStudent(
      {
        url: studentOperationUrl(sessionId, "overview"),
        headers: { "X-Student-Context": contextToken },
      },
      "Không thể tải lại phần giải thích file.",
    );
  }, []);

  const refreshContext = useCallback(async (sessionId) => {
    try {
      const response = await api.post(
        `/student/sessions/${encodeURIComponent(sessionId)}/context`,
      );
      return response.data;
    } catch (error) {
      throw gatewayRequestError(error, "Không thể làm mới phiên giải thích file.");
    }
  }, []);

  const askQuestion = useCallback(async (sessionId, contextToken, question) => {
    return requestStudent(
      {
        url: studentOperationUrl(sessionId, "questions"),
        method: "POST",
        data: { question },
        headers: { "X-Student-Context": contextToken },
      },
      "Không thể trả lời câu hỏi về file này.",
    );
  }, []);

  const getSourceRow = useCallback(
    async (sessionId, contextToken, worksheetRow, signal) => {
      return requestStudent(
        {
          url: studentOperationUrl(sessionId, `source-rows/${encodeURIComponent(worksheetRow)}`),
          headers: { "X-Student-Context": contextToken },
          signal,
        },
        "Không thể tải dòng nguồn được chọn.",
      );
    },
    [],
  );

  const getAccountingMap = useCallback(async (sessionId, contextToken) => {
    return requestStudent(
      { url: studentOperationUrl(sessionId, "accounting-map"), headers: { "X-Student-Context": contextToken } },
      "Không thể tải sơ đồ hạch toán.",
    );
  }, []);

  const getReconciliation = useCallback(async (sessionId, contextToken) => {
    return requestStudent(
      { url: studentOperationUrl(sessionId, "reconciliation"), headers: { "X-Student-Context": contextToken } },
      "Không thể tải kết quả đối chiếu.",
    );
  }, []);

  const previewAnonymization = useCallback(
    async (sessionId, contextToken, fullDocumentNumbers) => {
      return requestStudent(
        {
          url: studentOperationUrl(sessionId, "anonymization/preview"),
          method: "POST",
          data: { full_document_numbers: Boolean(fullDocumentNumbers) },
          headers: { "X-Student-Context": contextToken },
        },
        "Không thể xem trước bản ẩn danh.",
      );
    },
    [],
  );

  const exportAnonymizedWorkbook = useCallback(
    async (sessionId, contextToken, fullDocumentNumbers) => {
      try {
        const response = await api.post(
          studentOperationUrl(sessionId, "anonymization/export"),
          { full_document_numbers: Boolean(fullDocumentNumbers) },
          { responseType: "blob", headers: { "X-Student-Context": contextToken } },
        );
        return { blob: response.data, filename: "student-anonymized.xlsx" };
      } catch (error) {
        throw gatewayRequestError(error, "Không thể xuất workbook ẩn danh.");
      }
    },
    [],
  );

  const getActivities = useCallback(async (sessionId, contextToken) => {
    return requestStudent(
      {
        url: `/student/sessions/${encodeURIComponent(sessionId)}/activity`,
        headers: { "X-Student-Context": contextToken },
      },
      "Không thể tải hoạt động phiên giải thích file.",
    );
  }, []);

  const deleteActivities = useCallback(async (sessionId, contextToken) => {
    return requestStudent(
      {
        url: `/student/sessions/${encodeURIComponent(sessionId)}/activity`,
        method: "DELETE",
        headers: { "X-Student-Context": contextToken },
      },
      "Không thể xóa hoạt động phiên giải thích file.",
    );
  }, []);

  const generateInternshipReport = useCallback(
    async (sessionId, contextToken, request) => {
      try {
        const response = await api.post(
          studentOperationUrl(sessionId, "internship-report"),
          request,
          { responseType: "blob", headers: { "X-Student-Context": contextToken } },
        );
        return { blob: response.data, filename: "internship-handoff.md" };
      } catch (error) {
        throw gatewayRequestError(error, "Không thể tạo báo cáo bàn giao.");
      }
    },
    [],
  );

  return {
    createSession,
    analyzeSession,
    getOverview,
    refreshContext,
    askQuestion,
    getSourceRow,
    getAccountingMap,
    getReconciliation,
    previewAnonymization,
    exportAnonymizedWorkbook,
    getActivities,
    deleteActivities,
    generateInternshipReport,
  };
}
