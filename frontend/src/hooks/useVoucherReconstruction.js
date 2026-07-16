import { useCallback, useState } from "react";
import api from "../services/api";
import { filenameFromDisposition } from "../utils/reconstruction";

const pythonBaseURL = import.meta.env.VITE_PYTHON_API_URL
  ? `${import.meta.env.VITE_PYTHON_API_URL}`
  : "/python-api";

async function readJson(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.detail || payload.message || fallback);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function useVoucherReconstruction() {
  const [run, setRun] = useState(null);
  const [contextToken, setContextToken] = useState("");
  const [report, setReport] = useState(null);
  const [validation, setValidation] = useState(null);
  const [approved, setApproved] = useState(false);

  const createRun = useCallback(
    async ({ file, workspaceId, mode, targetTemplateId }) => {
      const { data } = await api.post("/reconstructions", {
        fileName: file.name,
        fileSizeBytes: file.size,
        workspaceId: workspaceId || "",
        mode,
        targetTemplateId: targetTemplateId || "",
      });
      setRun(data.run);
      setContextToken(data.contextToken);
      return data;
    },
    [],
  );

  const analyze = useCallback(
    async ({ file, contextToken: token, mode, targetTemplateId }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("context_token", token);
      form.append("mode", mode || "auto");
      if (targetTemplateId) form.append("target_template_id", targetTemplateId);
      const response = await fetch(`${pythonBaseURL}/api/v1/reconstructions/analyze`, {
        method: "POST",
        body: form,
      });
      const payload = await readJson(response, "Không thể tái tạo chứng từ.");
      setReport(payload);
      setValidation(null);
      setApproved(false);
      return payload;
    },
    [],
  );

  const request = useCallback(
    async (path, { method = "POST", body } = {}) => {
      if (!run?.id || !contextToken) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      const response = await fetch(
        `${pythonBaseURL}/api/v1/reconstructions/${run.id}${path}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "x-reconstruction-context": contextToken,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return readJson(response, "Không thể cập nhật chứng từ.");
    },
    [contextToken, run?.id],
  );

  const updateDraft = useCallback(
    async (draftId, expectedRevision, operations) => {
      const draft = await request(`/drafts/${draftId}`, {
        method: "PATCH",
        body: { expected_revision: expectedRevision, operations },
      });
      setReport((current) => ({
        ...current,
        drafts: (current?.drafts || []).map((item) =>
          item.id === draft.id ? draft : item,
        ),
      }));
      setValidation(null);
      setApproved(false);
      return draft;
    },
    [request],
  );

  const splitDraft = useCallback(
    async (draftId, expectedRevision, sourceRows) => {
      const payload = await request("/split", {
        body: {
          draft_id: draftId,
          expected_revision: expectedRevision,
          source_rows: sourceRows,
        },
      });
      setReport(payload);
      setValidation(null);
      setApproved(false);
      return payload;
    },
    [request],
  );

  const mergeDrafts = useCallback(
    async (drafts) => {
      const payload = await request("/merge", {
        body: {
          draft_ids: drafts.map((draft) => draft.id),
          expected_revisions: Object.fromEntries(
            drafts.map((draft) => [draft.id, draft.revision]),
          ),
        },
      });
      setReport(payload);
      setValidation(null);
      setApproved(false);
      return payload;
    },
    [request],
  );

  const validate = useCallback(async () => {
    const payload = await request("/validate", { body: {} });
    setValidation(payload);
    return payload;
  }, [request]);

  const approve = useCallback(
    async (acknowledgeWarnings) => {
      const payload = await request("/approve", {
        body: { acknowledge_warnings: acknowledgeWarnings },
      });
      setValidation(payload.validation);
      setApproved(true);
      return payload;
    },
    [request],
  );

  const exportFile = useCallback(
    async (acknowledgeWarnings) => {
      if (!run?.id || !contextToken) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      const response = await fetch(
        `${pythonBaseURL}/api/v1/reconstructions/${run.id}/export`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-reconstruction-context": contextToken,
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ acknowledge_warnings: acknowledgeWarnings }),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(
          payload.detail || payload.message || "Không thể xuất MISA.",
        );
        error.payload = payload;
        throw error;
      }
      const mediaType = response.headers.get("Content-Type") || "";
      const fallbackFilename = mediaType.includes("application/zip")
        ? "Import MISA.zip"
        : "Import MISA.xls";
      return {
        blob: await response.blob(),
        filename: filenameFromDisposition(
          response.headers.get("Content-Disposition"),
          fallbackFilename,
        ),
      };
    },
    [contextToken, run?.id],
  );

  const saveProfile = useCallback(
    async (payload, activate = true) => {
      if (!run?.id) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      const { data } = await api.post(`/reconstructions/${run.id}/profiles`, payload);
      if (activate) {
        const activated = await api.post(
          `/reconstructions/profiles/${data.profile.id}/activate`,
        );
        return activated.data.profile;
      }
      return data.profile;
    },
    [run?.id],
  );

  const reset = useCallback(() => {
    setRun(null);
    setContextToken("");
    setReport(null);
    setValidation(null);
    setApproved(false);
  }, []);

  return {
    run,
    contextToken,
    report,
    validation,
    approved,
    createRun,
    analyze,
    updateDraft,
    splitDraft,
    mergeDrafts,
    validate,
    approve,
    exportFile,
    saveProfile,
    reset,
  };
}
