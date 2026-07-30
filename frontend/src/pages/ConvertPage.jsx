import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle,
  Download,
  FileSpreadsheet,
  HelpCircle,
  Loader2,
  MoveRight,
  Server,
  UploadCloud,
  Wand2,
} from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import ChatSupport from "../components/ChatSupport";
import Alert from "../components/ui/Alert";
import StepProgress from "../components/ui/StepProgress";
import PreviewTable from "../components/PreviewTable";
import MappingCoverageSummary from "../components/MappingCoverageSummary";
import ValidationIssueTable from "../components/ValidationIssueTable";
import ValidationReadinessCard from "../components/ValidationReadinessCard";
import WorkspaceSelector from "../components/accounting/WorkspaceSelector";
import WorkspaceSetupModal from "../components/accounting/WorkspaceSetupModal";
import MasterDataManager from "../components/accounting/MasterDataManager";
import MasterDataResolutionTable from "../components/accounting/MasterDataResolutionTable";
import SmartReconstructionPanel from "../components/reconstruction/SmartReconstructionPanel";
import MappingProfileV2Card from "../components/converter/MappingProfileV2Card";
import { useConverterApi } from "../hooks/useConverterApi";
import { useAccountingWorkspaces } from "../hooks/useAccountingWorkspaces";
import { useAuth } from "../context/AuthContext";
import api from "../services/api";
import {
  classifyMappingField,
  filterMappingItems,
  getDownloadCtaState,
  summarizeMappingFields,
} from "../utils/converterUx";
import { getReconstructionAvailability } from "../utils/reconstruction";
import { extractProfileMatch } from "../utils/converterOperations.js";

const STATUS = {
  IDLE: "idle",
  ANALYZING: "analyzing",
  MAPPING: "mapping",
  PREVIEW: "preview",
  DOWNLOADING: "downloading",
  SUCCESS: "success",
  ERROR: "error",
};

const STEPS = ["Tải file", "Ghép cột", "Kiểm tra lỗi", "Tải MISA"];
const DEFAULT_TEMPLATE_ID = "bsn_sales";
const EXCEL_EXT = ["xlsx", "xls"];
const PDF_EXT = ["pdf"];
const RECONSTRUCTION_ENABLED =
  String(
    import.meta.env.VITE_VOUCHER_RECONSTRUCTION_ENABLED || "false",
  ).toLowerCase() === "true";

function ConversionModeTabs({ value, onChange }) {
  if (!RECONSTRUCTION_ENABLED) return null;
  return (
    <div className="border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="container-custom flex gap-2 py-3">
        <button
          type="button"
          onClick={() => onChange("mapping")}
          className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
            value === "mapping"
              ? "bg-slate-950 text-white"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          Ghép cột truyền thống
        </button>
        <button
          type="button"
          onClick={() => onChange("reconstruction")}
          className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
            value === "reconstruction"
              ? "bg-emerald-800 text-white"
              : "text-slate-600 hover:bg-emerald-50"
          }`}
        >
          Tái tạo chứng từ thông minh
        </button>
      </div>
    </div>
  );
}

const ColumnHelp = ({ text }) => {
  const iconRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = () => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 8,
      left: Math.min(Math.max(rect.left - 120, 12), window.innerWidth - 300),
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={iconRef}
        type="button"
        className="ml-1 inline-flex align-middle text-gray-400 transition-colors hover:text-primary-600"
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle size={13} />
      </button>
      {open &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[80] w-72 max-w-[80vw] rounded-xl bg-gray-900 px-3 py-2 text-[11px] font-medium leading-relaxed text-white shadow-lg whitespace-pre-line"
            style={{ top: position.top, left: position.left }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
};
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
    backendCapabilities,
    capabilities,
    capabilitiesOnline,
    analyzeFile,
    previewMapping,
    confirmMapping,
    checkReadiness,
    exportConfirmed,
  } = useConverterApi();
  const { user, refreshUser } = useAuth();
  const {
    enabled: workspacesEnabled,
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    snapshots,
    loading: workspacesLoading,
    error: workspacesError,
    createWorkspace,
    importCatalog,
    searchCatalog,
    activateSnapshot,
    saveAlias,
    createConversionContext,
  } = useAccountingWorkspaces();

  const planCode = String(user?.plan?.code || user?.plan || "free").toLowerCase();
  const isLimitedPlan = planCode === "free" || planCode === "perfile";
  const dailyFileCredit = Math.max(0, Number(user?.dailyFileCredit || 0));
  const fileCredits = Math.max(0, Number(user?.fileCredits || 0));
  const canConvert =
    !isLimitedPlan ||
    (planCode === "free"
      ? dailyFileCredit > 0
      : dailyFileCredit > 0 || fileCredits > 0);
  const reconstructionAvailability = getReconstructionAvailability({
    featureEnabled: RECONSTRUCTION_ENABLED,
    backendCapabilities,
  });
  const noCreditMessage =
    planCode === "free"
      ? "Bạn đã dùng hết lượt chuyển đổi miễn phí hôm nay. Vui lòng quay lại vào ngày mai hoặc nâng cấp gói."
      : "Bạn đã hết lượt chuyển đổi. Vui lòng mua thêm lượt hoặc nâng cấp gói.";

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
  const [readinessReport, setReadinessReport] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [profileId, setProfileId] = useState(null);
  const [conversionRunId, setConversionRunId] = useState(null);
  const [focusedTarget, setFocusedTarget] = useState("");
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [masterDataManagerOpen, setMasterDataManagerOpen] = useState(false);
  const [conversionContext, setConversionContext] = useState(null);
  const [masterDataState, setMasterDataState] = useState(null);
  const [conversionMode, setConversionMode] = useState("mapping");
  const [mappingFilter, setMappingFilter] = useState("all");

  const inputRef = useRef(null);
  const mappingTableRef = useRef(null);
  const readinessSectionRef = useRef(null);
  const targetRowRefs = useRef({});
  const targetFieldRefs = useRef({
    raw: {},
    default: {},
    formula: {},
  });

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
  const mappingSummary = useMemo(
    () =>
      summarizeMappingFields(
        targetHeaders,
        targetMapping,
        defaults,
        formulas,
        readinessReport?.issues || [],
      ),
    [defaults, formulas, readinessReport?.issues, targetHeaders, targetMapping],
  );
  const visibleMappingItems = useMemo(
    () => filterMappingItems(mappingSummary.items, mappingFilter),
    [mappingFilter, mappingSummary.items],
  );
  const mappingSource = analyzePayload?.mapping_suggestion?.source;
  const confidence = analyzePayload?.mapping_suggestion?.confidence;
  const profileV2Match = extractProfileMatch(analyzePayload);
  const extractTargetsFromText = (text) => {
    if (!text) return [];
    return [...targetHeaders]
      .sort((a, b) => b.length - a.length)
      .filter((header) => text.includes(header));
  };
  const inferFieldFromText = (text, target) => {
    const lowerText = (text || "").toLowerCase();
    if (lowerText.includes("công thức") || lowerText.includes("formula"))
      return "formula";
    if (lowerText.includes("mặc định") || lowerText.includes("default"))
      return "default";
    if (
      lowerText.includes("excel") ||
      lowerText.includes("mapping") ||
      lowerText.includes("ghép cột") ||
      lowerText.includes("map")
    ) {
      return "raw";
    }

    if (!targetMapping[target]) return "raw";
    if (defaults[target] === undefined || defaults[target] === "") return "default";
    return "formula";
  };
  const keyMappingValues = useMemo(
    () =>
      KEY_PREVIEW_HEADERS.filter((header) => targetHeaders.includes(header)).map(
        (header) => {
          const rawHeader = targetMapping[header];
          const formula = formulas[header];
          const defaultValue = defaults[header];
          const fieldState = classifyMappingField(
            header,
            targetMapping,
            defaults,
            formulas,
          );
          return {
            header,
            value:
              fieldState.mode === "mixed"
                ? "Nhiều cách điền · Cần rà soát"
                : rawHeader
                  ? rawHeader
                  : formula
                    ? `Công thức tự động: ${formula}`
                    : defaultValue !== undefined && defaultValue !== ""
                      ? `Giá trị mặc định: ${defaultValue}`
                      : "Chưa thiết lập",
            ok: fieldState.mode !== "unmapped",
            review: fieldState.mode === "mixed",
          };
        },
      ),
    [defaults, formulas, targetHeaders, targetMapping],
  );
  const keyMappingOkCount = keyMappingValues.filter((item) => item.ok).length;
  const liveMissingRequiredIssues = useMemo(
    () =>
      !analyzePayload
        ? []
        : targetHeaders
            .filter((header) => header.includes("(*)"))
            .filter((header) => {
              const rawHeader = targetMapping[header];
              const formula = formulas[header];
              const defaultValue = defaults[header];
              return !(
                rawHeader ||
                formula ||
                (defaultValue !== undefined && defaultValue !== "")
              );
            })
            .map((header) => ({
              code: "missing_required_mapping_live",
              message: `Thiếu thiết lập cho cột bắt buộc '${header}'.`,
            })),
    [analyzePayload, defaults, formulas, targetHeaders, targetMapping],
  );
  const nonRequiredIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const message = (issue?.message || String(issue)).toLowerCase();
        return !(
          message.includes("missing required misa mapping") ||
          message.includes("thiếu mapping cho cột bắt buộc") ||
          message.includes("thiếu thiết lập cho cột bắt buộc")
        );
      }),
    [issues],
  );
  const effectiveIssues = [...liveMissingRequiredIssues, ...nonRequiredIssues];
  const attentionItems = [
    ...warnings.slice(0, 6).map((message, index) => ({
      id: `warning-${index}`,
      message,
      targets: extractTargetsFromText(message),
    })),
    ...effectiveIssues.slice(0, 6).map((issue, index) => {
      const message = issue.message || String(issue);
      return {
        id: `${issue.code || "issue"}-${index}`,
        message,
        targets: extractTargetsFromText(message),
      };
    }),
  ];
  const mappingSourceLabel =
    mappingSource === "profile"
      ? "Thiết lập đã lưu"
      : mappingSource === "mixed"
        ? "Gợi ý kết hợp"
        : mappingSource === "ai"
          ? "AI gợi ý"
          : mappingSource === "manual"
            ? "Thiết lập thủ công"
            : mappingSource === "schema"
              ? "Gợi ý theo mẫu"
              : "Gợi ý hệ thống";
  const mappingConfidenceLabel =
    confidence !== undefined ? ` · Tin cậy ${Math.round(confidence * 100)}%` : "";

  const stepIndex =
    convStatus === STATUS.SUCCESS || convStatus === STATUS.DOWNLOADING
      ? 3
      : convStatus === STATUS.PREVIEW
        ? 2
        : convStatus === STATUS.MAPPING
          ? 1
          : 0;

  const downloadCta = getDownloadCtaState({
    hasAnalyzePayload: Boolean(analyzePayload?.upload_id),
    readinessReport,
    readinessLoading,
    acknowledgeWarnings,
    isDownloading: convStatus === STATUS.DOWNLOADING,
    isSuccess: convStatus === STATUS.SUCCESS,
  });

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
    setReadinessReport(null);
    setReadinessLoading(false);
    setAcknowledgeWarnings(false);
    setProfileId(null);
    setConversionRunId(null);
    setConversionContext(null);
    setMasterDataState(null);
    setMappingFilter("all");
  };

  const createConversionRunLog = async (file, templateId, context = null) => {
    if (!localStorage.getItem("token")) return null;
    try {
      const { data } = await api.post("/conversion-runs", {
        fileName: file.name,
        fileSizeBytes: file.size,
        targetTemplateId: templateId,
        workspaceId: context?.workspace?.id || "",
        snapshotSetHash: context?.snapshotSetHash || "",
      });
      const runId = data.run?.id || null;
      setConversionRunId(runId);
      return runId;
    } catch (err) {
      console.warn("[ConvertPage] Cannot create conversion run log:", err);
      return null;
    }
  };

  const updateConversionRunLog = async (
    status,
    payload = {},
    runId = conversionRunId,
  ) => {
    if (!runId || !localStorage.getItem("token")) return;
    try {
      await api.patch(`/conversion-runs/${runId}/status`, {
        status,
        ...payload,
      });
    } catch (err) {
      console.warn("[ConvertPage] Cannot update conversion run log:", err);
    }
  };

  const clearPreviewAfterMappingChange = () => {
    setPreviewHeaders([]);
    setPreviewRows([]);
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    setProfileId(null);
    if (convStatus === STATUS.PREVIEW || convStatus === STATUS.SUCCESS) {
      setConvStatus(STATUS.MAPPING);
    }
  };

  const focusTargetRow = (target, sourceText = "") => {
    const focusVisibleRow = () => {
      const row = targetRowRefs.current[target];
      const container = mappingTableRef.current;
      if (!row || !container) return;
      container.scrollTo({
        top: Math.max(row.offsetTop - 120, 0),
        behavior: "smooth",
      });
      setFocusedTarget(target);
      const field = inferFieldFromText(sourceText, target);
      const fieldElement = targetFieldRefs.current[field]?.[target];
      window.setTimeout(() => {
        fieldElement?.focus?.();
        fieldElement?.select?.();
      }, 260);
      window.setTimeout(() => setFocusedTarget(""), 1800);
    };

    if (mappingFilter !== "all") {
      setMappingFilter("all");
      requestAnimationFrame(() => requestAnimationFrame(focusVisibleRow));
      return;
    }
    focusVisibleRow();
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
    setConvStatus(STATUS.IDLE);
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
    let runId = null;
    try {
      const context = selectedWorkspaceId
        ? await createConversionContext(selectedWorkspaceId)
        : null;
      setConversionContext(context);
      runId = await createConversionRunLog(file, templateId, context);
      const result = await analyzeFile(file, templateId, context?.contextToken || null);
      const suggestion = result.mapping_suggestion || {};
      setAnalyzePayload(result);
      setTargetTemplateId(result.target_template_id || templateId);
      setTargetMapping(rawMappingToTargetMapping(suggestion.mapping));
      setDefaults(suggestion.defaults || {});
      setFormulas(suggestion.formulas || {});
      setWarnings(suggestion.warnings || []);
      setIssues(result.issues || []);
      setProfileId(suggestion.profile_id || null);
      setMasterDataState(result.master_data || null);
      setConvStatus(STATUS.MAPPING);
      await updateConversionRunLog(
        "processing",
        {
          converterUploadId: result.upload_id,
          targetTemplateId: result.target_template_id || templateId,
        },
        runId,
      );
    } catch (err) {
      console.error("[ConvertPage] Analyze failed:", err);
      await updateConversionRunLog(
        "failed",
        { errorMessage: err.message || "Không thể phân tích file." },
        runId,
      );
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
    conversion_context_token: conversionContext?.contextToken || null,
  });

  const buildReadinessPayload = (rows = null) => {
    const payload = buildMappingPayload();
    if (Array.isArray(rows)) {
      payload.rows = rows;
    }
    return payload;
  };

  const runReadinessCheck = async (rows = null) => {
    if (!analyzePayload?.upload_id) return null;
    setAcknowledgeWarnings(false);
    setReadinessReport(null);
    setReadinessLoading(true);
    try {
      const report = await checkReadiness(buildReadinessPayload(rows));
      setReadinessReport(report);
      setMasterDataState(report.master_data || null);
      return report;
    } finally {
      setReadinessLoading(false);
    }
  };

  const createPreview = async () => {
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    const result = await previewMapping(buildMappingPayload());
    setPreviewHeaders(result.headers || []);
    setPreviewRows(result.rows || []);
    setIssues(result.issues || []);
    setMasterDataState(result.master_data || null);
    await runReadinessCheck(result.rows || []);
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
      setErrorMsg(err.message || "Không thể xem trước dữ liệu.");
      setConvStatus(STATUS.MAPPING);
    }
  };

  const handleReadinessCheck = async () => {
    if (!analyzePayload?.upload_id) return;
    setErrorMsg("");
    try {
      if (previewRows.length) {
        await runReadinessCheck(previewRows);
        setConvStatus(STATUS.PREVIEW);
        return;
      }
      setConvStatus(STATUS.ANALYZING);
      await createPreview();
      setConvStatus(STATUS.PREVIEW);
    } catch (err) {
      console.error("[ConvertPage] Readiness check failed:", err);
      setErrorMsg(err.message || "Không kiểm tra được lỗi trước khi tải.");
      setConvStatus(previewRows.length ? STATUS.PREVIEW : STATUS.MAPPING);
    }
  };

  const saveProfileIfNeeded = async () => {
    if (profileId) return profileId;
    const result = await confirmMapping({
      ...buildMappingPayload(),
      profile_name: selectedTemplate?.label || "Thiết lập ghép cột",
    });
    setProfileId(result.profile_id);
    return result.profile_id;
  };

  const handleDownload = async () => {
    if (!analyzePayload?.upload_id) return;
    setConvStatus(STATUS.DOWNLOADING);
    setErrorMsg("");
    let exportStarted = false;
    try {
      const rowsToExport = previewRows;
      if (!rowsToExport.length || !readinessReport) {
        throw new Error("Vui lòng kiểm tra dữ liệu trước khi tải file MISA.");
      }
      if ((readinessReport?.summary?.blocker || 0) > 0) {
        throw new Error("Còn lỗi cần sửa trước khi tải file MISA.");
      }
      if ((readinessReport?.summary?.warning || 0) > 0 && !acknowledgeWarnings) {
        throw new Error(
          "Vui lòng rà soát và xác nhận các cảnh báo trước khi tải file MISA.",
        );
      }
      const savedProfileId = await saveProfileIfNeeded();
      exportStarted = true;
      const { blob, filename } = await exportConfirmed(
        analyzePayload.upload_id,
        savedProfileId,
        rowsToExport,
        acknowledgeWarnings,
        conversionContext?.contextToken || null,
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.download = filename;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      await updateConversionRunLog("completed", {
        converterUploadId: analyzePayload.upload_id,
        targetTemplateId,
      });
      setConvStatus(STATUS.SUCCESS);
      // Cập nhật lại lượt (đã bị trừ ở server) để badge hiển thị đúng.
      refreshUser?.().catch(() => {});
    } catch (err) {
      console.error("[ConvertPage] Download failed:", err);
      if (err.payload?.issues) {
        setReadinessReport(err.payload);
        setAcknowledgeWarnings(false);
      }
      if (exportStarted) {
        await updateConversionRunLog("failed", {
          converterUploadId: analyzePayload.upload_id,
          targetTemplateId,
          errorMessage: err.message || "Không thể tải file.",
        });
      }
      setErrorMsg(err.message || "Không thể tải file.");
      setConvStatus(previewRows.length ? STATUS.PREVIEW : STATUS.MAPPING);
    }
  };

  const handlePrimaryDownloadCta = async () => {
    if (downloadCta.action === "validate") {
      await handleReadinessCheck();
      requestAnimationFrame(() => {
        readinessSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
      return;
    }
    if (downloadCta.action === "download") {
      await handleDownload();
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    resetAnalysis();
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
  };

  const handleWorkspaceChange = (workspaceId) => {
    setSelectedWorkspaceId(workspaceId);
    resetAnalysis();
    setSelectedFile(null);
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
  };

  const handleCreateWorkspace = async (payload) => {
    const workspace = await createWorkspace(payload);
    resetAnalysis();
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
    return workspace;
  };

  const handleActivateMasterData = async (snapshotId) => {
    await activateSnapshot(selectedWorkspaceId, snapshotId);
    resetAnalysis();
    setErrorMsg("");
    if (selectedFile) {
      await runAnalyze(selectedFile, targetTemplateId);
    } else {
      setConvStatus(STATUS.IDLE);
    }
  };

  const handleConfirmMasterDataAlias = async (resolution, targetCode) => {
    if (!selectedWorkspaceId) return;
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    await saveAlias(selectedWorkspaceId, {
      type: resolution.catalog_type,
      rawValue: resolution.raw_value,
      targetCode,
      sourceSystem: analyzePayload?.detected?.source_signature_hash || "default",
    });
    const refreshedContext = await createConversionContext(selectedWorkspaceId);
    setConversionContext(refreshedContext);
    const payload = {
      ...buildMappingPayload(),
      conversion_context_token: refreshedContext.contextToken,
    };
    const result = await previewMapping(payload);
    setPreviewHeaders(result.headers || []);
    setPreviewRows(result.rows || []);
    setMasterDataState(result.master_data || null);
    const readiness = await checkReadiness({
      ...payload,
      rows: result.rows || [],
    });
    setReadinessReport(readiness);
    setMasterDataState(readiness.master_data || result.master_data || null);
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

  const handlePreviewCellChange = (rowIndex, header, value) => {
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    setPreviewRows((prev) =>
      prev.map((row, index) =>
        index === rowIndex ? { ...row, [header]: value } : row,
      ),
    );
  };

  const handlePreviewRowDelete = (rowIndex) => {
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    setPreviewRows((prev) => prev.filter((_, index) => index !== rowIndex));
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />
      <ConversionModeTabs value={conversionMode} onChange={setConversionMode} />

      <main className="flex-1 pb-20 sm:pb-0">
        {conversionMode === "reconstruction" && RECONSTRUCTION_ENABLED ? (
          <SmartReconstructionPanel
            templates={templates}
            serviceOnline={serviceOnline}
            reconstructionAvailable={reconstructionAvailability.enabled}
            reconstructionUnavailableReason={reconstructionAvailability.reason}
            canConvert={canConvert}
            noCreditMessage={noCreditMessage}
            workspacesEnabled={workspacesEnabled}
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedWorkspace={selectedWorkspace}
            onWorkspaceChange={handleWorkspaceChange}
            onOpenWorkspaceSetup={() => setWorkspaceSetupOpen(true)}
            onOpenMasterData={() => setMasterDataManagerOpen(true)}
            searchCatalog={searchCatalog}
            refreshUser={refreshUser}
          />
        ) : (
          <section className="py-8 sm:py-12 px-4">
            <div className="max-w-[1440px] mx-auto">
              <StepProgress steps={STEPS} current={stepIndex} />

              <div className="text-center mb-6 sm:mb-8">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
                  Chuyển đổi Excel → Chuẩn định dạng kế toán
                </h1>
                <p className="text-sm sm:text-base text-gray-500 mt-2 max-w-2xl mx-auto">
                  Hệ thống đọc cấu trúc file nhập liệu chuẩn của phần mềm kế toán chuyên
                  dụng, nhận biết tên cột cần có trong biểu mẫu và tự gợi ý ghép cột từ
                  file Excel để bạn kiểm tra, chỉnh sửa trước khi tải file.
                </p>
              </div>

              {serviceOnline === false && (
                <Alert
                  variant="warning"
                  title="Bộ chuyển đổi chưa sẵn sàng"
                  className="mb-5"
                >
                  Chạy bộ chuyển đổi trước khi phân tích file. Nếu AI tạm thời không
                  hoạt động, bạn vẫn có thể ghép cột thủ công.
                </Alert>
              )}

              {serviceOnline === true && (
                <div className="flex items-center justify-center gap-4 mb-4 flex-wrap">
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                    <Server size={14} />
                    Bộ chuyển đổi đang hoạt động
                  </p>
                  {aiOnline === true && (
                    <p className="flex items-center gap-1.5 text-xs text-violet-700">
                      <span className="inline-block w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
                      AI đang hoạt động
                    </p>
                  )}
                  {aiOnline === false && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600">
                      <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                      AI tạm thời không hoạt động — ghép cột thủ công
                    </p>
                  )}
                </div>
              )}

              <div className="grid gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
                <div className="space-y-4 xl:sticky xl:top-24 xl:self-start">
                  {workspacesEnabled && (
                    <>
                      <WorkspaceSelector
                        workspaces={workspaces}
                        selectedWorkspaceId={selectedWorkspaceId}
                        selectedWorkspace={selectedWorkspace}
                        loading={workspacesLoading}
                        onSelect={handleWorkspaceChange}
                        onCreate={() => setWorkspaceSetupOpen(true)}
                        onManage={() => setMasterDataManagerOpen(true)}
                      />
                      {workspacesError && (
                        <Alert variant="warning" className="text-left">
                          {workspacesError}
                        </Alert>
                      )}
                    </>
                  )}

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
                      Template chuẩn từ phần mềm kế toán
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
                        convStatus === STATUS.ANALYZING ||
                        !canConvert
                      }
                    >
                      {convStatus === STATUS.ANALYZING && !analyzePayload ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : (
                        <Wand2 size={18} />
                      )}
                      Phân tích & gợi ý ghép cột
                    </button>

                    {isLimitedPlan && !canConvert && (
                      <Alert variant="warning" className="text-left">
                        {noCreditMessage}
                      </Alert>
                    )}

                    {analyzePayload && (
                      <div className="rounded-xl bg-gray-50 p-3 text-xs text-gray-600 space-y-1">
                        <p>
                          Trang tính:{" "}
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
                          Nguồn gợi ý:{" "}
                          <span className="font-medium">
                            {mappingSourceLabel}
                            {mappingConfidenceLabel}
                          </span>
                        </p>
                        <p className="pt-1 text-[11px] text-gray-500">
                          Độ tin cậy chỉ phản ánh gợi ý ghép cột, không xác nhận dữ liệu
                          đúng nghiệp vụ.
                        </p>
                      </div>
                    )}

                    {analyzePayload && (
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                        <button
                          type="button"
                          className="btn-secondary w-full justify-center py-3"
                          onClick={handlePreview}
                          disabled={convStatus === STATUS.DOWNLOADING}
                        >
                          <Wand2 size={16} />
                          Xem trước
                        </button>
                        <div className="space-y-1.5">
                          <button
                            type="button"
                            className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${
                              downloadCta.action === "download"
                                ? "bg-emerald-600 hover:bg-emerald-700"
                                : downloadCta.action === "validate"
                                  ? "bg-primary-600 hover:bg-primary-700"
                                  : "bg-slate-600"
                            }`}
                            onClick={handlePrimaryDownloadCta}
                            disabled={
                              downloadCta.disabled ||
                              convStatus === STATUS.ANALYZING ||
                              (!canConvert && convStatus !== STATUS.SUCCESS)
                            }
                          >
                            {downloadCta.loading ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : downloadCta.action === "validate" ? (
                              <CheckCircle size={16} />
                            ) : (
                              <Download size={16} />
                            )}
                            {downloadCta.label}
                          </button>
                          <p
                            className="text-center text-[11px] leading-relaxed text-gray-500"
                            aria-live="polite"
                          >
                            {downloadCta.helper}
                          </p>
                        </div>
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
                  {errorMsg && convStatus !== STATUS.ANALYZING && (
                    <Alert variant="error" className="text-left">
                      {errorMsg}
                    </Alert>
                  )}

                  {attentionItems.length > 0 && (
                    <Alert
                      variant="warning"
                      title={`Cần kiểm tra · ${attentionItems.length} mục`}
                      className="text-left"
                    >
                      <div className="space-y-3">
                        {attentionItems.length > 0 && (
                          <ul className="list-disc pl-4 space-y-2">
                            {attentionItems.map((item) => (
                              <li key={item.id}>
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                                  <div>{item.message}</div>
                                  {item.targets.length > 0 && (
                                    <div className="flex shrink-0 flex-wrap gap-2">
                                      {item.targets.map((target) => (
                                        <button
                                          key={`${item.id}-${target}`}
                                          type="button"
                                          className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-white px-3.5 py-1.5 text-sm font-bold text-amber-800 shadow-sm hover:bg-amber-50"
                                          onClick={() =>
                                            focusTargetRow(target, item.message)
                                          }
                                        >
                                          Đi tới
                                          <MoveRight size={15} />
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </Alert>
                  )}

                  {!analyzePayload && convStatus !== STATUS.ANALYZING && (
                    <div className="rounded-3xl border border-gray-200 bg-white p-8 sm:p-12 shadow-card text-center">
                      <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3" />
                      <h2 className="text-base font-semibold text-gray-800">
                        Chưa có gợi ý ghép cột
                      </h2>
                      <p className="text-sm text-gray-500 mt-1">
                        Tải file lên rồi bấm phân tích để hệ thống đọc cấu trúc cột và
                        gợi ý ghép cột.
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
                      <div className="px-5 sm:px-6 py-5 border-b border-gray-100 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                        <div className="min-w-0">
                          <h2 className="text-2xl font-black text-gray-900">
                            Ghép cột Excel → Chuẩn định dạng kế toán
                          </h2>
                          <p className="mt-1 text-sm leading-relaxed text-gray-600">
                            Với <strong>mỗi dòng cột theo chuẩn</strong>, bạn chỉ chọn{" "}
                            <strong>1 trong 3 ô</strong>:{" "}
                            <strong>Cột từ file Excel</strong>,{" "}
                            <strong>Giá trị mặc định</strong> hoặc{" "}
                            <strong>Công thức tự động</strong>. Sau khi đã chọn 1 cách,
                            bạn có thể <strong>để trống 2 ô còn lại</strong>. Ví dụ: nếu
                            đã chọn cột từ Excel thì không cần nhập giá trị mặc định hay
                            công thức cho cùng dòng đó.
                          </p>
                        </div>
                      </div>

                      {capabilities.mapping_profile_v2 && (
                        <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
                          <MappingProfileV2Card
                            profileMatch={profileV2Match}
                            serviceOnline={capabilitiesOnline !== false}
                            busy={convStatus === STATUS.ANALYZING}
                            onUse={handlePreview}
                          />
                        </div>
                      )}

                      {keyMappingValues.length > 0 && (
                        <div className="border-b border-blue-100 bg-blue-50/60 px-5 py-4 sm:px-6">
                          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-lg font-bold text-blue-950">
                                Tự động ghép cột quan trọng
                              </p>
                              <p className="text-sm text-blue-700">
                                {keyMappingOkCount}/{keyMappingValues.length} trường
                                quan trọng đã được thiết lập.
                              </p>
                            </div>
                            <span className="inline-flex w-fit rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-blue-700 ring-1 ring-blue-100">
                              {mappingSourceLabel}
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                            {keyMappingValues.map((item) => (
                              <div
                                key={item.header}
                                className={`rounded-xl border px-3 py-2 ${
                                  item.review
                                    ? "border-rose-200 bg-rose-50"
                                    : item.ok
                                      ? "border-emerald-100 bg-white"
                                    : "border-amber-200 bg-amber-50"
                                }`}
                              >
                                <div className="text-[11px] uppercase tracking-wide text-gray-500">
                                  {item.header}
                                </div>
                                <div
                                  className={`mt-1 truncate text-sm font-semibold ${
                                    item.review
                                      ? "text-rose-700"
                                      : item.ok
                                        ? "text-gray-900"
                                        : "text-amber-700"
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

                      <MappingCoverageSummary
                        summary={mappingSummary}
                        activeFilter={mappingFilter}
                        onFilterChange={setMappingFilter}
                        confidence={confidence}
                        sourceLabel={mappingSourceLabel}
                      />

                      {(readinessReport || readinessLoading) && (
                        <div
                          ref={readinessSectionRef}
                          className="scroll-mt-24 space-y-3 border-b border-gray-100 bg-white px-5 py-4 sm:px-6"
                        >
                          <ValidationReadinessCard
                            report={readinessReport}
                            loading={readinessLoading}
                            acknowledgeWarnings={acknowledgeWarnings}
                            onAcknowledgeWarningsChange={setAcknowledgeWarnings}
                          />
                          <ValidationIssueTable
                            issues={readinessReport?.issues || []}
                          />
                        </div>
                      )}

                      {masterDataState?.resolutions?.length > 0 && (
                        <div className="border-b border-gray-100 bg-gray-50/70 px-5 py-4 sm:px-6">
                          <MasterDataResolutionTable
                            masterData={masterDataState}
                            onConfirmAlias={handleConfirmMasterDataAlias}
                            onSetupWorkspace={() => setWorkspaceSetupOpen(true)}
                            onManageMasterData={() => setMasterDataManagerOpen(true)}
                            hasWorkspace={Boolean(selectedWorkspaceId)}
                            onSearchCandidates={(type, query) =>
                              searchCatalog(selectedWorkspaceId, type, query)
                            }
                          />
                        </div>
                      )}

                      <div
                        ref={mappingTableRef}
                        className="overflow-auto max-h-[620px]"
                      >
                        <table className="min-w-[1180px] text-sm">
                          <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-500 uppercase">
                            <tr>
                              <th className="px-4 py-3 text-left w-[24%]">
                                Cột theo định dạng chuẩn
                              </th>
                              <th className="px-4 py-3 text-left w-[24%]">
                                Cột từ file Excel
                                <ColumnHelp text="Chọn cột dữ liệu tương ứng từ file Excel của bạn." />
                              </th>
                              <th className="px-4 py-3 text-left w-[20%]">
                                Giá trị mặc định
                                <ColumnHelp text="Dùng khi bạn muốn điền sẵn một giá trị cố định cho mọi dòng của cột này." />
                              </th>
                              <th className="px-4 py-3 text-left w-[32%]">
                                Công thức tự động
                                <ColumnHelp
                                  text={
                                    "Dùng để tự tạo giá trị theo mẫu.\nBạn có thể gõ chữ thường và chèn dữ liệu bằng cú pháp ${Tên cột}.\n\nVí dụ:\n- XK_${Số chứng từ (*)}\n- ${Mã khách hàng}_${Ngày chứng từ (*)}\n\nNếu không cần công thức, bạn có thể để trống ô này."
                                  }
                                />
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleMappingItems.map((mappingItem) => {
                              const target = mappingItem.target;
                              const matchedRaw = targetMapping[target] || "";
                              const isHighlighted = focusedTarget === target;
                              return (
                                <tr
                                  key={target}
                                  ref={(node) => {
                                    if (node) targetRowRefs.current[target] = node;
                                    else delete targetRowRefs.current[target];
                                  }}
                                  className={`border-t border-gray-100 align-top transition-colors ${
                                    isHighlighted
                                      ? "bg-amber-50/80"
                                      : mappingItem.mode === "mixed"
                                        ? "bg-rose-50/60"
                                        : "bg-white"
                                  }`}
                                >
                                  <td className="px-4 py-3 font-semibold text-gray-800">
                                    <div>{target}</div>
                                    {mappingItem.mode === "mixed" && (
                                      <span className="mt-1 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                                        Nhiều cách điền · Cần rà soát
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    <select
                                      ref={(node) => {
                                        if (node)
                                          targetFieldRefs.current.raw[target] = node;
                                        else delete targetFieldRefs.current.raw[target];
                                      }}
                                      className="w-full min-w-[190px] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                                      value={matchedRaw}
                                      onChange={(e) =>
                                        updateTargetMapping(target, e.target.value)
                                      }
                                    >
                                      <option value="">— Không lấy từ Excel —</option>
                                      {rawHeaders.map((rawHeader) => (
                                        <option key={rawHeader} value={rawHeader}>
                                          {rawHeader}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="px-4 py-3">
                                    <input
                                      ref={(node) => {
                                        if (node)
                                          targetFieldRefs.current.default[target] =
                                            node;
                                        else
                                          delete targetFieldRefs.current.default[
                                            target
                                          ];
                                      }}
                                      type="text"
                                      className="w-full min-w-[160px] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                                      placeholder="Giá trị mặc định"
                                      value={defaults[target] ?? ""}
                                      onChange={(e) =>
                                        updateDefault(target, e.target.value)
                                      }
                                    />
                                  </td>
                                  <td className="px-4 py-3">
                                    <input
                                      ref={(node) => {
                                        if (node)
                                          targetFieldRefs.current.formula[target] =
                                            node;
                                        else
                                          delete targetFieldRefs.current.formula[
                                            target
                                          ];
                                      }}
                                      type="text"
                                      className="w-full min-w-[320px] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                                      placeholder="VD: XK_${Số chứng từ (*)}"
                                      value={formulas[target] ?? ""}
                                      onChange={(e) =>
                                        updateFormula(target, e.target.value)
                                      }
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                            {visibleMappingItems.length === 0 && (
                              <tr>
                                <td
                                  colSpan={4}
                                  className="border-t border-gray-100 px-4 py-10 text-center text-sm text-gray-500"
                                >
                                  Không có cột phù hợp với bộ lọc hiện tại.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {convStatus === STATUS.PREVIEW && previewRows.length > 0 && (
                        <div className="border-t border-gray-100 bg-white px-5 py-4 sm:px-6">
                          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <h3 className="text-lg font-bold text-gray-900">
                                Xem trước dữ liệu đầu ra
                              </h3>
                              <p className="text-sm text-gray-500">
                                Bạn có thể chỉnh sửa trực tiếp trước khi tải file.
                              </p>
                            </div>
                            <div className="flex flex-col xs:flex-row gap-2">
                              <button
                                type="button"
                                className="btn-secondary justify-center"
                                onClick={handlePreview}
                                disabled={convStatus === STATUS.DOWNLOADING}
                              >
                                <Wand2 size={16} />
                                Làm mới xem trước
                              </button>
                              <button
                                type="button"
                                className="btn-secondary justify-center"
                                onClick={handleReadinessCheck}
                                disabled={
                                  convStatus === STATUS.DOWNLOADING || readinessLoading
                                }
                              >
                                {readinessLoading ? (
                                  <Loader2 size={16} className="animate-spin" />
                                ) : (
                                  <CheckCircle size={16} />
                                )}
                                Kiểm tra lỗi
                              </button>
                              <div className="space-y-1">
                                <button
                                  type="button"
                                  className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${
                                    downloadCta.action === "download"
                                      ? "bg-emerald-600 hover:bg-emerald-700"
                                      : downloadCta.action === "validate"
                                        ? "bg-primary-600 hover:bg-primary-700"
                                        : "bg-slate-600"
                                  }`}
                                  onClick={handlePrimaryDownloadCta}
                                  disabled={downloadCta.disabled}
                                >
                                  {downloadCta.loading ? (
                                    <Loader2 size={16} className="animate-spin" />
                                  ) : downloadCta.action === "validate" ? (
                                    <CheckCircle size={16} />
                                  ) : (
                                    <Download size={16} />
                                  )}
                                  {downloadCta.label}
                                </button>
                                <p
                                  className="max-w-[240px] text-center text-[11px] leading-relaxed text-gray-500"
                                  aria-live="polite"
                                >
                                  {downloadCta.helper}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
                            <PreviewTable
                              headers={previewHeaders}
                              rows={previewRows}
                              onCellChange={handlePreviewCellChange}
                              onDeleteRow={handlePreviewRowDelete}
                            />
                          </div>
                        </div>
                      )}

                      {convStatus === STATUS.SUCCESS && (
                        <Alert
                          variant="success"
                          title="Đã xuất file kết quả"
                          className="rounded-none border-0 border-t border-emerald-100"
                        >
                          Thiết lập ghép cột đã được lưu. Nếu chưa lưu được file (lỡ bấm
                          hủy hộp thoại lưu), bạn có thể bấm{" "}
                          <strong>Tải lại file kết quả</strong> để tải lại mà không tốn
                          thêm lượt.
                        </Alert>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      <Footer />
      <ChatSupport initialMessages={[{ from: "bot", text: "Coming soon..." }]} />
      {workspacesEnabled && (
        <>
          <WorkspaceSetupModal
            open={workspaceSetupOpen}
            onClose={() => setWorkspaceSetupOpen(false)}
            onCreate={handleCreateWorkspace}
          />
          <MasterDataManager
            open={masterDataManagerOpen}
            workspace={selectedWorkspace}
            snapshots={snapshots}
            onClose={() => setMasterDataManagerOpen(false)}
            onImport={(type, file) => importCatalog(selectedWorkspaceId, type, file)}
            onActivate={handleActivateMasterData}
          />
        </>
      )}
    </div>
  );
};

export default ConvertPage;
