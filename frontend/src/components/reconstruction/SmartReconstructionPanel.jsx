import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  GitMerge,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import Alert from "../ui/Alert";
import ValidationIssueTable from "../ValidationIssueTable";
import WorkspaceSelector from "../accounting/WorkspaceSelector";
import { useVoucherReconstruction } from "../../hooks/useVoucherReconstruction";
import { flattenValidationIssues, hasActiveCatalog } from "../../utils/reconstruction";
import ReconstructionSummary from "./ReconstructionSummary";
import VoucherList from "./VoucherList";
import VoucherReviewWorkspace from "./VoucherReviewWorkspace";

const EXCEL_TYPES = ["xls", "xlsx"];

function extension(file) {
  return file?.name?.split(".").pop()?.toLowerCase() || "";
}

export default function SmartReconstructionPanel({
  templates,
  serviceOnline,
  canConvert,
  noCreditMessage,
  workspacesEnabled,
  workspaces,
  selectedWorkspaceId,
  selectedWorkspace,
  onWorkspaceChange,
  onOpenWorkspaceSetup,
  onOpenMasterData,
  searchCatalog,
  refreshUser,
}) {
  const inputRef = useRef(null);
  const reconstruction = useVoucherReconstruction();
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("auto");
  const [targetTemplateId, setTargetTemplateId] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [mergeSelection, setMergeSelection] = useState([]);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const report = reconstruction.report;
  const selectedDraft = useMemo(
    () =>
      report?.drafts?.find((draft) => draft.id === selectedDraftId) ||
      report?.drafts?.[0] ||
      null,
    [report?.drafts, selectedDraftId],
  );
  const validationIssues = useMemo(
    () => flattenValidationIssues(reconstruction.validation),
    [reconstruction.validation],
  );
  const validationSummary = reconstruction.validation?.summary || {};

  useEffect(() => {
    if (
      report?.drafts?.length &&
      !report.drafts.some((draft) => draft.id === selectedDraftId)
    ) {
      setSelectedDraftId(report.drafts[0].id);
    }
  }, [report?.drafts, selectedDraftId]);

  const reset = () => {
    reconstruction.reset();
    setFile(null);
    setSelectedDraftId("");
    setMergeSelection([]);
    setAcknowledgeWarnings(false);
    setError("");
    setMessage("");
  };

  const chooseFile = (candidate) => {
    if (!candidate) return;
    if (!EXCEL_TYPES.includes(extension(candidate))) {
      setError("Chỉ chấp nhận file Excel .xls hoặc .xlsx.");
      return;
    }
    reconstruction.reset();
    setFile(candidate);
    setSelectedDraftId("");
    setError("");
    setMessage("");
  };

  const analyze = async () => {
    if (!file) return;
    if (!canConvert) {
      setError(noCreditMessage);
      return;
    }
    setBusy("analyze");
    setError("");
    setMessage("");
    try {
      const created = await reconstruction.createRun({
        file,
        workspaceId: selectedWorkspaceId,
        mode,
        targetTemplateId,
      });
      const payload = await reconstruction.analyze({
        file,
        contextToken: created.contextToken,
        mode,
        targetTemplateId,
      });
      setSelectedDraftId(payload.drafts?.[0]?.id || "");
      setMessage(
        `Đã tái tạo ${payload.summary?.draft_count || 0} chứng từ từ file nguồn.`,
      );
    } catch (requestError) {
      setError(requestError.message || "Không thể tái tạo chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const updateDraft = async (draft, operations) => {
    setBusy("edit");
    setError("");
    try {
      const updated = await reconstruction.updateDraft(
        draft.id,
        draft.revision,
        operations,
      );
      setSelectedDraftId(updated.id);
    } catch (requestError) {
      setError(requestError.message || "Không thể cập nhật chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const splitDraft = async (draft, rows) => {
    setBusy("split");
    setError("");
    try {
      const payload = await reconstruction.splitDraft(draft.id, draft.revision, rows);
      setSelectedDraftId(payload.drafts?.[0]?.id || "");
    } catch (requestError) {
      setError(requestError.message || "Không thể tách chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const mergeDrafts = async () => {
    if (mergeSelection.length !== 2) return;
    setBusy("merge");
    setError("");
    try {
      const selected = report.drafts.filter((draft) =>
        mergeSelection.includes(draft.id),
      );
      const payload = await reconstruction.mergeDrafts(selected);
      setMergeSelection([]);
      setSelectedDraftId(payload.drafts?.at(-1)?.id || "");
    } catch (requestError) {
      setError(requestError.message || "Không thể gộp chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const validate = async () => {
    setBusy("validate");
    setError("");
    try {
      await reconstruction.validate();
    } catch (requestError) {
      setError(requestError.message || "Không thể kiểm tra chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const approve = async () => {
    setBusy("approve");
    setError("");
    try {
      await reconstruction.approve(acknowledgeWarnings);
      setMessage("Đã phê duyệt phiên tái tạo. Bạn có thể tải file MISA.");
    } catch (requestError) {
      if (requestError.payload?.summary) {
        await reconstruction.validate().catch(() => {});
      }
      setError(requestError.message || "Chứng từ chưa đủ điều kiện phê duyệt.");
    } finally {
      setBusy("");
    }
  };

  const download = async () => {
    setBusy("export");
    setError("");
    try {
      const { blob, filename } = await reconstruction.exportFile(acknowledgeWarnings);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage("Đã xuất file MISA từ các chứng từ được phê duyệt.");
      refreshUser?.().catch(() => {});
    } catch (requestError) {
      setError(requestError.message || "Không thể tải file MISA.");
    } finally {
      setBusy("");
    }
  };

  const saveProfile = async () => {
    if (!report) return;
    setBusy("profile");
    setError("");
    try {
      const routing = {};
      report.drafts.forEach((draft) => {
        if (draft.nature && draft.template_id)
          routing[draft.nature] = draft.template_id;
      });
      await reconstruction.saveProfile(
        {
          name: `Tái tạo ${file?.name || "file nguồn"}`,
          sourceSignatureHash: report.source_signature_hash,
          directionScope: mode,
          groupingKeys: ["supplier_tax_code", "invoice_symbol", "invoice_number"],
          fillDownFields: [
            "invoice_number",
            "invoice_symbol",
            "invoice_date",
            "supplier_tax_code",
            "supplier_name",
            "payment_method",
          ],
          fieldRoles: report.detected_columns || {},
          templateRouting: routing,
        },
        true,
      );
      setMessage("Đã lưu và kích hoạt cách tái tạo cho file có cấu trúc tương tự.");
    } catch (requestError) {
      setError(requestError.message || "Không thể lưu cấu hình tái tạo.");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="pb-16 pt-6 sm:pt-10">
      <div className="container-custom space-y-5">
        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_#dff7ef,_transparent_36%),linear-gradient(135deg,#f8fafc,#eef7f4)] shadow-card">
          <div className="grid gap-6 p-6 lg:grid-cols-[1.2fr_0.8fr] lg:p-8">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-950 px-3 py-1 text-xs font-bold text-emerald-50">
                <Sparkles size={14} /> Giai đoạn 3
              </div>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Tái tạo chứng từ thông minh
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
                Hệ thống nhóm các dòng Excel thành từng chứng từ, phân loại mua/bán và
                hàng hóa/dịch vụ, sau đó kiểm tra trước khi điền vào template MISA thật.
              </p>
            </div>
            <div className="space-y-3 rounded-2xl border border-white/80 bg-white/80 p-4 backdrop-blur">
              {workspacesEnabled && (
                <WorkspaceSelector
                  workspaces={workspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  selectedWorkspace={selectedWorkspace}
                  onSelect={onWorkspaceChange}
                  onCreate={onOpenWorkspaceSetup}
                  onManage={onOpenMasterData}
                  loading={false}
                />
              )}
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="error" title="Không thể xử lý">
            {error}
          </Alert>
        )}
        {message && (
          <Alert variant="success" title="Đã cập nhật">
            {message}
          </Alert>
        )}
        {serviceOnline === false && (
          <Alert variant="error">Converter backend chưa sẵn sàng.</Alert>
        )}
        {!canConvert && <Alert variant="warning">{noCreditMessage}</Alert>}

        {!report && (
          <div className="grid gap-5 rounded-[28px] border border-gray-200 bg-white p-5 shadow-card lg:grid-cols-[1fr_320px] lg:p-7">
            <button
              type="button"
              className="flex min-h-64 flex-col items-center justify-center rounded-3xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 p-6 text-center transition hover:border-emerald-400 hover:bg-emerald-50"
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".xls,.xlsx"
                className="hidden"
                onChange={(event) => {
                  chooseFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <UploadCloud size={42} className="text-emerald-600" />
              <p className="mt-4 text-lg font-black text-gray-900">
                {file?.name || "Chọn file Excel dữ liệu thô"}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
                  : "Hỗ trợ .xls và .xlsx"}
              </p>
            </button>
            <div className="space-y-4">
              <label className="block text-sm font-bold text-gray-800">
                Chiều chứng từ
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 px-3 py-2.5 font-medium"
                >
                  <option value="auto">Tự nhận diện</option>
                  <option value="purchase">Mua vào</option>
                  <option value="sales">Bán ra</option>
                </select>
              </label>
              <label className="block text-sm font-bold text-gray-800">
                Template ưu tiên
                <select
                  value={targetTemplateId}
                  onChange={(event) => setTargetTemplateId(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 px-3 py-2.5 font-medium"
                >
                  <option value="">Tự chọn theo từng chứng từ</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-primary w-full justify-center"
                disabled={!file || busy || serviceOnline === false || !canConvert}
                onClick={analyze}
              >
                {busy === "analyze" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Sparkles size={18} />
                )}
                Phân tích và tái tạo
              </button>
              {file && (
                <button
                  type="button"
                  className="btn-secondary w-full justify-center"
                  onClick={() => setFile(null)}
                >
                  Chọn file khác
                </button>
              )}
            </div>
          </div>
        )}

        {report && (
          <>
            <ReconstructionSummary report={report} />
            {report.structure?.warnings?.length > 0 && (
              <Alert variant="warning" title="Cấu trúc workbook cần chú ý">
                <ul className="list-disc space-y-1 pl-4">
                  {report.structure.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {report.ai?.used && (
              <Alert variant="info" title="AI đã hỗ trợ nhận diện cấu trúc">
                AI chỉ gợi ý field và cách nhóm dòng. Chứng từ vẫn cần được kiểm tra và
                phê duyệt trước khi tải MISA.
              </Alert>
            )}
            {report.ai?.warning && (
              <Alert variant="warning" title="AI tạm thời không hoạt động">
                {report.ai.warning}. Hệ thống đã tiếp tục bằng rule và cho phép bạn sửa
                thủ công.
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <button
                type="button"
                className="btn-secondary"
                onClick={validate}
                disabled={busy}
              >
                <CheckCircle2 size={16} /> Kiểm tra lại
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={mergeDrafts}
                disabled={busy || mergeSelection.length !== 2}
              >
                <GitMerge size={16} /> Gộp 2 chứng từ
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={saveProfile}
                disabled={busy || !selectedWorkspaceId}
              >
                <Save size={16} /> Lưu cách xử lý
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={reset}
                disabled={busy}
              >
                <RefreshCw size={16} /> File khác
              </button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {(validationSummary.warning || 0) > 0 && (
                  <label className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                    <input
                      type="checkbox"
                      checked={acknowledgeWarnings}
                      onChange={(event) => setAcknowledgeWarnings(event.target.checked)}
                    />{" "}
                    Tôi đã kiểm tra cảnh báo
                  </label>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={approve}
                  disabled={
                    busy ||
                    (validationSummary.blocker || 0) > 0 ||
                    ((validationSummary.warning || 0) > 0 && !acknowledgeWarnings)
                  }
                >
                  {busy === "approve" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}{" "}
                  Phê duyệt
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                  onClick={download}
                  disabled={busy || !reconstruction.approved}
                >
                  {busy === "export" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}{" "}
                  Tải MISA
                </button>
              </div>
            </div>

            {reconstruction.validation && (
              <div className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <strong>Kiểm tra đầu ra:</strong>
                  <span className="text-red-700">
                    {validationSummary.blocker || 0} lỗi chặn
                  </span>
                  <span className="text-amber-800">
                    {validationSummary.warning || 0} cảnh báo
                  </span>
                  <span className="text-gray-500">
                    {validationSummary.info || 0} thông tin
                  </span>
                </div>
                <ValidationIssueTable issues={validationIssues} />
              </div>
            )}

            <div className="grid min-h-[660px] overflow-hidden rounded-[28px] border border-gray-200 bg-white shadow-card lg:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="border-b border-gray-200 lg:border-b-0 lg:border-r">
                <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
                  <p className="text-sm font-black text-gray-900">Danh sách chứng từ</p>
                  <p className="text-xs text-gray-500">
                    Tick đúng hai dòng để sử dụng chức năng gộp.
                  </p>
                </div>
                <div className="max-h-[620px] overflow-y-auto">
                  <VoucherList
                    drafts={report.drafts}
                    selectedId={selectedDraft?.id}
                    onSelect={setSelectedDraftId}
                    mergeSelection={mergeSelection}
                    onMergeSelectionChange={(id, checked) =>
                      setMergeSelection((current) =>
                        checked
                          ? [...new Set([...current, id])].slice(-2)
                          : current.filter((item) => item !== id),
                      )
                    }
                  />
                </div>
              </aside>
              <main className="min-w-0">
                {busy === "edit" && (
                  <div className="border-b border-blue-100 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-800">
                    Đang lưu thay đổi…
                  </div>
                )}
                <VoucherReviewWorkspace
                  draft={selectedDraft}
                  onUpdate={updateDraft}
                  onSplit={splitDraft}
                  onSearchCatalog={
                    selectedWorkspaceId
                      ? (type, query) =>
                          hasActiveCatalog(selectedWorkspace, type)
                            ? searchCatalog(selectedWorkspaceId, type, query)
                            : Promise.resolve([])
                      : null
                  }
                />
              </main>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
