import { useCallback, useRef, useState } from "react";
import api from "../services/api";
import { filenameFromDisposition } from "../utils/reconstruction";

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

export function useVoucherReconstruction() {
  const [run, setRun] = useState(null);
  const [contextToken, setContextToken] = useState("");
  const [report, setReport] = useState(null);
  const [validation, setValidation] = useState(null);
  const [approved, setApproved] = useState(false);
  const runIdRef = useRef("");

  const createRun = useCallback(
    async ({ file, workspaceId, mode, targetTemplateId }) => {
      let data;
      try {
        ({ data } = await api.post("/reconstructions", {
          fileName: file.name,
          fileSizeBytes: file.size,
          workspaceId: workspaceId || "",
          mode,
          targetTemplateId: targetTemplateId || "",
        }));
      } catch (error) {
        throw gatewayRequestError(error, "Không thể tạo phiên tái tạo chứng từ.");
      }
      setRun(data.run);
      runIdRef.current = data.run?.id || "";
      setContextToken(data.contextToken);
      return data;
    },
    [],
  );

  const analyze = useCallback(
    async ({ file, contextToken: token, mode, targetTemplateId }) => {
      const runId = runIdRef.current || run?.id;
      if (!runId) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      const form = new FormData();
      form.append("file", file);
      form.append("context_token", token);
      form.append("mode", mode || "auto");
      if (targetTemplateId) form.append("target_template_id", targetTemplateId);
      let payload;
      try {
        const response = await api.post(`/reconstructions/${encodeURIComponent(runId)}/operations/analyze`, form);
        payload = response.data;
      } catch (error) {
        throw gatewayRequestError(error, "Không thể tái tạo chứng từ.");
      }
      setReport(payload);
      setValidation(null);
      setApproved(false);
      return payload;
    },
    [run?.id],
  );

  const request = useCallback(
    async (path, { method = "POST", body } = {}) => {
      if (!run?.id || !contextToken) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      try {
        const response = await api.request({
          url: `/reconstructions/${encodeURIComponent(run.id)}/operations${path}`,
          method,
          data: body,
          headers: { "x-reconstruction-context": contextToken },
        });
        return response.data;
      } catch (error) {
        throw gatewayRequestError(error, "Không thể cập nhật chứng từ.");
      }
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
      let response;
      try {
        response = await api.post(
          `/reconstructions/${encodeURIComponent(run.id)}/operations/export`,
          { acknowledge_warnings: acknowledgeWarnings },
          {
            responseType: "blob",
            headers: {
              "x-reconstruction-context": contextToken,
              "Idempotency-Key": globalThis.crypto?.randomUUID?.(),
            },
          },
        );
      } catch (error) {
        throw gatewayRequestError(error, "Không thể xuất MISA.");
      }
      const mediaType = response.headers?.["content-type"] || "";
      const fallbackFilename = mediaType.includes("application/zip")
        ? "Import MISA.zip"
        : "Import MISA.xls";
      return {
        blob: response.data,
        filename: filenameFromDisposition(
          response.headers?.["content-disposition"],
          fallbackFilename,
        ),
      };
    },
    [contextToken, run?.id],
  );

  const saveProfile = useCallback(
    async (payload, activate = true) => {
      if (!run?.id) throw new Error("Phiên tái tạo chưa sẵn sàng.");
      try {
        const { data } = await api.post(`/reconstructions/${run.id}/profiles`, payload);
        if (activate) {
          const activated = await api.post(
            `/reconstructions/profiles/${data.profile.id}/activate`,
          );
          return activated.data.profile;
        }
        return data.profile;
      } catch (error) {
        throw gatewayRequestError(error, "Không thể lưu hồ sơ tái tạo.");
      }
    },
    [run?.id],
  );

  const reset = useCallback(() => {
    setRun(null);
    runIdRef.current = "";
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
