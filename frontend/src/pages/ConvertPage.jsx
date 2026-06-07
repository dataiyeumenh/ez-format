import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Download,
  FileSpreadsheet,
  Loader2,
  MessageCircle,
  Send,
  Server,
  UploadCloud,
  Wand2,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import Alert from "../components/ui/Alert";
import StepProgress from "../components/ui/StepProgress";
import PreviewTable from "../components/PreviewTable";
import { useConverterApi } from "../hooks/useConverterApi";

const STATUS = {
  IDLE: "idle",
  ANALYZING: "analyzing",
  MAPPING: "mapping",
  PREVIEW: "preview",
  DOWNLOADING: "downloading",
  SUCCESS: "success",
  ERROR: "error",
};

const STEPS = ["Tải file", "Map cột", "Xem trước", "Tải MISA"];
const DEFAULT_TEMPLATE_ID = "bsn_sales";
const EXCEL_EXT = ["xlsx", "xls"];
const PDF_EXT = ["pdf"];
const KEY_PREVIEW_HEADERS = [
  "Số chứng từ (*)",
  "Ngày hạch toán (*)",
  "Mã khách hàng",
  "Tên khách hàng",
  "Mã hàng (*)",
  "Số lượng",
  "Đơn giá",
  "Thành tiền",
  "Tiền chiết khấu",
  "Số lô",
  "Hạn sử dụng",
];

function rawMappingToTargetMapping(mapping = {}) {
  const output = {};
  Object.entries(mapping).forEach(([rawHeader, targetSpec]) => {
    const targets = Array.isArray(targetSpec) ? targetSpec : [targetSpec];
    targets.forEach((target) => {
      if (target) output[target] = rawHeader;
    });
  });
  return output;
}

function targetMappingToRawMapping(targetMapping = {}) {
  const grouped = {};
  Object.entries(targetMapping).forEach(([target, rawHeader]) => {
    if (!rawHeader) return;
    if (!grouped[rawHeader]) grouped[rawHeader] = [];
    grouped[rawHeader].push(target);
  });
  return Object.fromEntries(
    Object.entries(grouped).map(([rawHeader, targets]) => [
      rawHeader,
      targets.length === 1 ? targets[0] : targets,
    ]),
  );
}

const fileExtension = (file) => file?.name?.split(".").pop()?.toLowerCase() ?? "";

const ConvertPage = () => {
  const {
    templates,
    serviceOnline,
    aiOnline,
    analyzeFile,
    previewMapping,
    confirmMapping,
    exportConfirmed,
  } = useConverterApi();

  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [targetTemplateId, setTargetTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [convStatus, setConvStatus] = useState(STATUS.IDLE);
  const [errorMsg, setErrorMsg] = useState("");
  const [analyzePayload, setAnalyzePayload] = useState(null);
  const [targetMapping, setTargetMapping] = useState({});
  const [defaults, setDefaults] = useState({});
  const [formulas, setFormulas] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [issues, setIssues] = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewStats, setPreviewStats] = useState(null);
  const [profileId, setProfileId] = useState(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([
    { from: "bot", text: "Xin chào! Tôi có thể giúp gì cho bạn?" },
    {
      from: "bot",
      text: "Hỏi về chuyển đổi Excel → MISA, mapping cột hoặc hỗ trợ kỹ thuật.",
    },
  ]);

  const inputRef = useRef(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === targetTemplateId),
    [templates, targetTemplateId],
  );
  const rawHeaders = analyzePayload?.detected?.headers || [];
  const targetHeaders = useMemo(() => {
    if (selectedTemplate?.headers?.length) return selectedTemplate.headers;
    if (analyzePayload?.target_headers?.length) return analyzePayload.target_headers;
    return previewHeaders || [];
  }, [analyzePayload?.target_headers, previewHeaders, selectedTemplate?.headers]);
  const mappingSource = analyzePayload?.mapping_suggestion?.source;
  const confidence = analyzePayload?.mapping_suggestion?.confidence;
  const keyPreviewValues = useMemo(() => {
    const firstRow = previewRows[0];
    if (!firstRow) return [];
    return KEY_PREVIEW_HEADERS.filter((header) => previewHeaders.includes(header)).map(
      (header) => ({
        header,
        value:
          firstRow[header] !== undefined &&
          firstRow[header] !== null &&
          firstRow[header] !== ""
            ? String(firstRow[header])
            : "—",
      }),
    );
  }, [previewHeaders, previewRows]);
  const keyMappingValues = useMemo(
    () =>
      KEY_PREVIEW_HEADERS.filter((header) => targetHeaders.includes(header)).map(
        (header) => {
          const rawHeader = targetMapping[header];
          const formula = formulas[header];
          const defaultValue = defaults[header];
          return {
            header,
            value: rawHeader
              ? rawHeader
              : formula
                ? `Formula: ${formula}`
                : defaultValue !== undefined && defaultValue !== ""
                  ? `Default: ${defaultValue}`
                  : "Chưa map",
            ok: Boolean(
              rawHeader ||
              formula ||
              (defaultValue !== undefined && defaultValue !== ""),
            ),
          };
        },
      ),
    [defaults, formulas, targetHeaders, targetMapping],
  );
  const keyMappingOkCount = keyMappingValues.filter((item) => item.ok).length;

  const stepIndex =
    convStatus === STATUS.MAPPING
      ? 1
      : convStatus === STATUS.PREVIEW || convStatus === STATUS.DOWNLOADING
        ? 2
        : convStatus === STATUS.SUCCESS
          ? 3
          : 0;

  useEffect(() => {
    if (!templates.length) return;
    if (!templates.some((template) => template.id === targetTemplateId)) {
      setTargetTemplateId(templates[0].id);
    }
  }, [templates, targetTemplateId]);

  const resetAnalysis = () => {
    setAnalyzePayload(null);
    setTargetMapping({});
    setDefaults({});
    setFormulas({});
    setWarnings([]);
    setIssues([]);
    setPreviewHeaders([]);
    setPreviewRows([]);
    setPreviewStats(null);
    setProfileId(null);
  };

  const clearPreviewAfterMappingChange = () => {
    setPreviewHeaders([]);
    setPreviewRows([]);
    setPreviewStats(null);
    setProfileId(null);
    if (convStatus === STATUS.PREVIEW || convStatus === STATUS.SUCCESS) {
      setConvStatus(STATUS.MAPPING);
    }
  };

  const acceptFile = (file) => {
    if (!file) return;
    const ext = fileExtension(file);
    resetAnalysis();
    if (PDF_EXT.includes(ext)) {
      setErrorMsg("Chưa hỗ trợ PDF. Vui lòng xuất dữ liệu sang Excel (.xlsx/.xls).");
      setConvStatus(STATUS.ERROR);
      setSelectedFile(null);
      return;
    }
    if (!EXCEL_EXT.includes(ext)) {
      setErrorMsg("Chỉ chấp nhận tệp Excel (.xlsx, .xls).");
      setConvStatus(STATUS.ERROR);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setErrorMsg("");
    if (serviceOnline === false) {
      setConvStatus(STATUS.IDLE);
      return;
    }
    runAnalyze(file, targetTemplateId);
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  };

  const handleFileInput = (e) => {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
    e.target.value = "";
  };

  const handleAnalyze = async () => {
    if (!selectedFile || !targetTemplateId) return;
    await runAnalyze(selectedFile, targetTemplateId);
  };

  async function runAnalyze(file, templateId) {
    if (!file || !templateId) return;
    setConvStatus(STATUS.ANALYZING);
    setErrorMsg("");
    resetAnalysis();
    try {
      const result = await analyzeFile(file, templateId);
      const suggestion = result.mapping_suggestion || {};
      setAnalyzePayload(result);
      setTargetTemplateId(result.target_template_id || templateId);
      setTargetMapping(rawMappingToTargetMapping(suggestion.mapping));
      setDefaults(suggestion.defaults || {});
      setFormulas(suggestion.formulas || {});
      setWarnings(suggestion.warnings || []);
      setIssues(result.issues || []);
      setProfileId(suggestion.profile_id || null);
      setConvStatus(STATUS.MAPPING);
    } catch (err) {
      console.error("[ConvertPage] Analyze failed:", err);
      setErrorMsg(err.message || "Không thể phân tích file.");
      setConvStatus(STATUS.ERROR);
    }
  }

  const buildMappingPayload = () => ({
    upload_id: analyzePayload?.upload_id,
    target_template_id: targetTemplateId,
    mapping: targetMappingToRawMapping(targetMapping),
    defaults,
    formulas,
  });

  const createPreview = async () => {
    const result = await previewMapping(buildMappingPayload());
    setPreviewHeaders(result.headers || []);
    setPreviewRows(result.rows || []);
    setIssues(result.issues || []);
    setPreviewStats(result.stats || null);
    return result;
  };

  const handlePreview = async () => {
    if (!analyzePayload?.upload_id) return;
    window.scrollBy({ top: 800, behavior: "smooth" });

    setConvStatus(STATUS.ANALYZING);
    setErrorMsg("");
    try {
      await createPreview();
      setConvStatus(STATUS.PREVIEW);
    } catch (err) {
      console.error("[ConvertPage] Preview failed:", err);
      setErrorMsg(err.message || "Không thể xem trước dữ liệu MISA.");
      setConvStatus(STATUS.MAPPING);
    }
  };

  const saveProfileIfNeeded = async () => {
    if (profileId) return profileId;
    const result = await confirmMapping({
      ...buildMappingPayload(),
      profile_name: selectedTemplate?.label || "MISA mapping profile",
    });
    setProfileId(result.profile_id);
    return result.profile_id;
  };

  const handleDownload = async () => {
    if (!analyzePayload?.upload_id) return;
    setConvStatus(STATUS.DOWNLOADING);
    setErrorMsg("");
    try {
      if (!previewRows.length) {
        const preview = await createPreview();
        if (!(preview.rows || []).length) {
          throw new Error("Không có dòng dữ liệu MISA để tải.");
        }
      }
      const savedProfileId = await saveProfileIfNeeded();
      const { blob, filename } = await exportConfirmed(
        analyzePayload.upload_id,
        savedProfileId,
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.download = filename;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setConvStatus(STATUS.SUCCESS);
    } catch (err) {
      console.error("[ConvertPage] Download failed:", err);
      setErrorMsg(err.message || "Không thể tải file MISA.");
      setConvStatus(previewRows.length ? STATUS.PREVIEW : STATUS.MAPPING);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    resetAnalysis();
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
  };

  const updateTargetMapping = (target, rawHeader) => {
    setTargetMapping((prev) => ({ ...prev, [target]: rawHeader }));
    clearPreviewAfterMappingChange();
  };

  const updateDefault = (target, value) => {
    setDefaults((prev) => ({ ...prev, [target]: value }));
    clearPreviewAfterMappingChange();
  };

  const updateFormula = (target, value) => {
    setFormulas((prev) => {
      const next = { ...prev };
      if (value) next[target] = value;
      else delete next[target];
      return next;
    });
    clearPreviewAfterMappingChange();
  };

  const sendChatMessage = () => {
    if (!chatInput.trim()) return;
    setMessages((prev) => [
      ...prev,
      { from: "user", text: chatInput.trim() },
      {
        from: "bot",
        text: "Cảm ơn bạn! Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể.",
      },
    ]);
    setChatInput("");
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />

      <main className="flex-1 pb-20 sm:pb-0">
        <section className="py-8 sm:py-12 px-4">
          <div className="max-w-6xl mx-auto">
            <StepProgress steps={STEPS} current={stepIndex} />

            <div className="text-center mb-6 sm:mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
                Chuyển đổi Excel thô → MISA
              </h1>
              <p className="text-sm sm:text-base text-gray-500 mt-2 max-w-2xl mx-auto">
                Backend đọc template MISA chuẩn, gợi ý mapping bằng profile/AI optional,
                cho bạn sửa trước khi lưu setting và tải file.
              </p>
            </div>

            {serviceOnline === false && (
              <Alert
                variant="warning"
                title="Backend converter chưa sẵn sàng"
                className="mb-5"
              >
                Chạy converter FastAPI trước khi phân tích file. Nếu AI Gateway offline,
                backend vẫn cho sửa mapping thủ công.
              </Alert>
            )}

            {serviceOnline === true && (
              <div className="flex items-center justify-center gap-4 mb-4 flex-wrap">
                <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                  <Server size={14} />
                  Backend converter đang hoạt động
                </p>
                {aiOnline === true && (
                  <p className="flex items-center gap-1.5 text-xs text-violet-700">
                    <span className="inline-block w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
                    AI Gateway đang hoạt động
                  </p>
                )}
                {aiOnline === false && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-600">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                    AI Gateway offline — mapping thủ công
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
              <div className="space-y-4">
                <div
                  className={`rounded-3xl border-2 border-dashed p-6 sm:p-8 text-center transition-all ${
                    dragActive
                      ? "border-primary-500 bg-primary-50/80"
                      : selectedFile
                        ? "border-primary-300 bg-white shadow-card"
                        : "border-gray-200 bg-white/90 hover:border-primary-300 hover:shadow-card"
                  }`}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                  onClick={() => !selectedFile && inputRef.current?.click()}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".xlsx,.xls,.pdf"
                    className="hidden"
                    onChange={handleFileInput}
                  />
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-400">
                      <UploadCloud size={30} />
                    </div>
                    {selectedFile ? (
                      <>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">
                            {selectedFile.name}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-red-600 underline-offset-2 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleReset();
                          }}
                        >
                          Chọn file khác
                        </button>
                      </>
                    ) : (
                      <>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">
                            Kéo thả file Excel thô vào đây
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            .xlsx hoặc .xls — tối đa 20 MB
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn-primary w-full sm:w-auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            inputRef.current?.click();
                          }}
                        >
                          <FileSpreadsheet size={16} />
                          Chọn file Excel
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-card space-y-3">
                  <label className="block text-sm font-medium text-gray-700">
                    Template MISA đích
                    <select
                      className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                      value={targetTemplateId}
                      onChange={(e) => {
                        setTargetTemplateId(e.target.value);
                        resetAnalysis();
                        setConvStatus(STATUS.IDLE);
                        setErrorMsg("");
                      }}
                    >
                      {(templates.length
                        ? templates
                        : [
                            {
                              id: DEFAULT_TEMPLATE_ID,
                              label: "BSN - Form import bán hàng",
                            },
                          ]
                      ).map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="btn-primary w-full py-3"
                    onClick={handleAnalyze}
                    disabled={
                      !selectedFile ||
                      serviceOnline === false ||
                      convStatus === STATUS.ANALYZING
                    }
                  >
                    {convStatus === STATUS.ANALYZING && !analyzePayload ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Wand2 size={18} />
                    )}
                    Phân tích & gợi ý mapping
                  </button>

                  {analyzePayload && (
                    <div className="rounded-xl bg-gray-50 p-3 text-xs text-gray-600 space-y-1">
                      <p>
                        Sheet:{" "}
                        <span className="font-medium">
                          {analyzePayload.detected?.sheet_name}
                        </span>
                      </p>
                      <p>
                        Dòng dữ liệu:{" "}
                        <span className="font-medium">
                          {analyzePayload.detected?.row_count}
                        </span>
                      </p>
                      <p>
                        Mapping:{" "}
                        <span className="font-medium">
                          {mappingSource || "—"}{" "}
                          {confidence !== undefined
                            ? `(${Math.round(confidence * 100)}%)`
                            : ""}
                        </span>
                      </p>
                    </div>
                  )}
                </div>

                <p className="text-center text-xs text-gray-400">
                  <Link to="/" className="text-primary-600 hover:underline">
                    ← Về trang chủ
                  </Link>
                </p>
              </div>

              <div className="space-y-4 min-w-0">
                {convStatus === STATUS.ERROR && errorMsg && (
                  <Alert variant="error" className="text-left">
                    {errorMsg}
                  </Alert>
                )}

                {warnings.length > 0 && (
                  <Alert
                    variant="warning"
                    title="Cảnh báo mapping"
                    className="text-left"
                  >
                    <ul className="list-disc pl-4 space-y-0.5">
                      {warnings.slice(0, 6).map((warning, index) => (
                        <li key={`${warning}-${index}`}>{warning}</li>
                      ))}
                    </ul>
                  </Alert>
                )}

                {issues.length > 0 && (
                  <Alert
                    variant="warning"
                    title="Vấn đề cần kiểm tra"
                    className="text-left"
                  >
                    <ul className="list-disc pl-4 space-y-0.5">
                      {issues.slice(0, 6).map((issue, index) => (
                        <li key={`${issue.code || "issue"}-${index}`}>
                          {issue.message || String(issue)}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}

                {!analyzePayload && convStatus !== STATUS.ANALYZING && (
                  <div className="rounded-3xl border border-gray-200 bg-white p-8 sm:p-12 shadow-card text-center">
                    <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3" />
                    <h2 className="text-base font-semibold text-gray-800">
                      Chưa có mapping
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">
                      Upload file rồi bấm phân tích để backend đọc schema và gợi ý
                      mapping.
                    </p>
                  </div>
                )}

                {convStatus === STATUS.ANALYZING && (
                  <div className="rounded-3xl border border-primary-100 bg-white p-8 sm:p-12 shadow-card flex flex-col items-center gap-4">
                    <Loader2 size={40} className="text-primary-500 animate-spin" />
                    <p className="text-sm font-semibold text-gray-800 text-center">
                      Đang xử lý…
                    </p>
                    <p className="text-xs text-gray-400 text-center">
                      File lớn có thể mất vài chục giây.
                    </p>
                  </div>
                )}

                {analyzePayload && convStatus !== STATUS.ANALYZING && (
                  <div className="rounded-3xl border border-gray-200 bg-white shadow-card overflow-hidden">
                    <div className="px-4 sm:px-5 py-4 border-b border-gray-100 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold text-gray-900">
                          Mapping raw → MISA
                        </h2>
                        <p className="text-xs text-gray-500">
                          Chọn cột raw, default hoặc formula cho từng cột MISA.
                        </p>
                      </div>
                      <div className="flex w-full flex-col xs:flex-row gap-2 lg:w-auto lg:shrink-0">
                        <button
                          type="button"
                          className="btn-secondary justify-center px-5"
                          onClick={handlePreview}
                          disabled={convStatus === STATUS.DOWNLOADING}
                        >
                          <Wand2 size={16} />
                          Preview
                        </button>
                        <button
                          type="button"
                          className="btn-primary justify-center px-5"
                          onClick={handleDownload}
                          disabled={
                            convStatus === STATUS.DOWNLOADING ||
                            convStatus === STATUS.ANALYZING
                          }
                        >
                          {convStatus === STATUS.DOWNLOADING ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <Download size={16} />
                          )}
                          Tải MISA
                        </button>
                      </div>
                    </div>

                    {keyMappingValues.length > 0 && (
                      <div className="border-b border-blue-100 bg-blue-50/60 p-4">
                        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-blue-950">
                              Auto mapping cột chính
                            </p>
                            <p className="text-xs text-blue-700">
                              {keyMappingOkCount}/{keyMappingValues.length} trường quan
                              trọng đã có raw/default/formula.
                            </p>
                          </div>
                          <span className="inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100">
                            {mappingSource || "mapping"}{" "}
                            {confidence !== undefined
                              ? `${Math.round(confidence * 100)}%`
                              : ""}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                          {keyMappingValues.map((item) => (
                            <div
                              key={item.header}
                              className={`rounded-xl border px-3 py-2 ${
                                item.ok
                                  ? "border-emerald-100 bg-white"
                                  : "border-amber-200 bg-amber-50"
                              }`}
                            >
                              <div className="text-[11px] uppercase tracking-wide text-gray-500">
                                {item.header}
                              </div>
                              <div
                                className={`mt-1 truncate text-sm font-semibold ${
                                  item.ok ? "text-gray-900" : "text-amber-700"
                                }`}
                                title={item.value}
                              >
                                {item.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="overflow-auto max-h-[520px]">
                      <table className="min-w-full text-sm">
                        <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-500 uppercase">
                          <tr>
                            <th className="px-3 py-2 text-left w-[28%]">Cột MISA</th>
                            <th className="px-3 py-2 text-left w-[28%]">Cột raw</th>
                            <th className="px-3 py-2 text-left w-[22%]">Default</th>
                            <th className="px-3 py-2 text-left w-[22%]">Formula</th>
                          </tr>
                        </thead>
                        <tbody>
                          {targetHeaders.map((target) => (
                            <tr key={target} className="border-t border-gray-100">
                              <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                                {target}
                              </td>
                              <td className="px-3 py-2">
                                <select
                                  className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
                                  value={targetMapping[target] || ""}
                                  onChange={(e) =>
                                    updateTargetMapping(target, e.target.value)
                                  }
                                >
                                  <option value="">— Không map —</option>
                                  {rawHeaders.map((raw) => (
                                    <option key={`${target}-${raw}`} value={raw}>
                                      {raw}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="text"
                                  className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                                  value={defaults[target] ?? ""}
                                  onChange={(e) =>
                                    updateDefault(target, e.target.value)
                                  }
                                  placeholder="Giá trị mặc định"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="text"
                                  className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                                  value={formulas[target] ?? ""}
                                  onChange={(e) =>
                                    updateFormula(target, e.target.value)
                                  }
                                  placeholder="VD: XK_${Số chứng từ (*)}"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {previewRows.length > 0 && (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
                      <CheckCircle size={18} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold">Preview MISA đã tạo</p>
                        <p className="text-xs">
                          {previewStats?.output_rows || previewRows.length} dòng output
                          từ {previewStats?.source_rows || "?"} dòng raw.
                        </p>
                      </div>
                    </div>
                    {keyPreviewValues.length > 0 && (
                      <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-blue-950">
                              Dòng đầu - cột chính
                            </p>
                            <p className="text-xs text-blue-700">
                              Kiểm tra nhanh các trường MISA quan trọng trước khi tải.
                            </p>
                          </div>
                        </div>
                        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {keyPreviewValues.map((item) => (
                            <div
                              key={item.header}
                              className="rounded-xl bg-white/80 border border-blue-100 px-3 py-2"
                            >
                              <dt className="text-[11px] uppercase tracking-wide text-blue-500">
                                {item.header}
                              </dt>
                              <dd className="mt-1 text-sm font-semibold text-gray-900 truncate">
                                {item.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                    <PreviewTable
                      headers={previewHeaders}
                      rows={previewRows}
                      onCellChange={() => {}}
                      onDeleteRow={() => {}}
                      disabled
                    />
                  </div>
                )}

                {convStatus === STATUS.SUCCESS && (
                  <Alert
                    variant="success"
                    title="Đã xuất file MISA"
                    className="text-left"
                  >
                    Setting mapping đã được lưu. Lần sau upload file cùng schema,
                    backend sẽ ưu tiên dùng profile này.
                  </Alert>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />

      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-40 flex flex-col items-end gap-3">
        {chatOpen && (
          <div className="w-[calc(100vw-2rem)] sm:w-80 max-h-[70vh] bg-white rounded-3xl shadow-2xl border border-gray-100 overflow-hidden animate-fade-in">
            <div className="px-4 py-3 bg-primary-600 text-white flex justify-between items-center">
              <div>
                <p className="text-sm font-semibold">EzFormat Support</p>
                <p className="text-xs text-primary-100">Phản hồi trong vài phút</p>
              </div>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                className="p-1 hover:bg-white/10 rounded-lg"
                aria-label="Đóng chat"
              >
                <X size={16} />
              </button>
            </div>
            <div className="h-52 sm:h-64 overflow-y-auto p-4 space-y-3 bg-gray-50/80 table-scroll">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                      msg.from === "user"
                        ? "bg-primary-600 text-white rounded-br-md"
                        : "bg-white text-gray-700 border border-gray-100 shadow-sm rounded-bl-md"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-3 py-3 bg-white border-t flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
                placeholder="Nhập tin nhắn..."
                className="flex-1 min-w-0 text-sm px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500/25"
              />
              <button
                type="button"
                onClick={sendChatMessage}
                className="w-10 h-10 shrink-0 bg-primary-600 hover:bg-primary-700 rounded-xl flex items-center justify-center text-white"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setChatOpen(!chatOpen)}
          className="w-12 h-12 sm:w-14 sm:h-14 bg-primary-600 hover:bg-primary-700 rounded-full shadow-lg shadow-primary-500/30 flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95"
          aria-label={chatOpen ? "Đóng chat" : "Mở chat"}
        >
          {chatOpen ? <X size={20} /> : <MessageCircle size={20} />}
        </button>
      </div>
    </div>
  );
};

export default ConvertPage;
