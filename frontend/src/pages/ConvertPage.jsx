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
import ValidationIssueTable from "../components/ValidationIssueTable";
import ValidationReadinessCard from "../components/ValidationReadinessCard";
import WorkspaceSelector from "../components/accounting/WorkspaceSelector";
import WorkspaceSetupModal from "../components/accounting/WorkspaceSetupModal";
import MasterDataManager from "../components/accounting/MasterDataManager";
import MasterDataResolutionTable from "../components/accounting/MasterDataResolutionTable";
import SmartReconstructionPanel from "../components/reconstruction/SmartReconstructionPanel";
import MappingProfileV2Card from "../components/converter/MappingProfileV2Card";
import AnomalyWorkspace from "../components/converter/AnomalyWorkspace";
import BulkCorrectionDialog from "../components/converter/BulkCorrectionDialog";
import ReconciliationWorkspace from "../components/converter/ReconciliationWorkspace";
import AccountingAssistantDrawer from "../components/converter/AccountingAssistantDrawer";
import { describeAiStatus, useConverterApi } from "../hooks/useConverterApi";
import { useConversionSession } from "../hooks/useConversionSession";
import { useAccountingWorkspaces } from "../hooks/useAccountingWorkspaces";
import { useAuth } from "../context/AuthContext";
import { getConverterSteps } from "../utils/operationSession.js";
import {
  buildAnomalyReviewPayload,
  buildAssistantQuestionPayload,
  buildCorrectionPayload,
  extractProfileMatch,
  getConfirmedProfilePresentation,
} from "../utils/converterOperations.js";

const STATUS = {
  IDLE: "idle",
  ANALYZING: "analyzing",
  MAPPING: "mapping",
  PREVIEW: "preview",
  DOWNLOADING: "downloading",
  SUCCESS: "success",
  ERROR: "error",
};

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

const displayMappingWarning = (warning) =>
  warning === "ai_unavailable"
    ? "AI mapping không khả dụng; hệ thống đang dùng heuristic an toàn."
    : warning;

const ConvertPage = () => {
  const {
    templates,
    serviceOnline,
    aiOnline,
    aiStatus,
    capabilities,
    capabilitiesOnline,
    analyzeFile,
    previewMapping,
    syncMappingSession,
    confirmMapping,
    checkReadiness,
    exportConfirmed,
    detectAnomalies,
    reviewAnomaly,
    proposeCorrections,
    simulateCorrections,
    applyCorrections,
    undoCorrections,
    getSessionRevisions,
    addComparisonFile,
    removeComparisonFile,
    runReconciliation,
    confirmReconciliationMatch,
    askAccountingQuestion,
  } = useConverterApi();
  const operationSession = useConversionSession();
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
    createPersonalConversionContext,
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
  const [useAiMapping, setUseAiMapping] = useState(false);
  const [confirmedProfile, setConfirmedProfile] = useState(null);
  const [focusedTarget, setFocusedTarget] = useState("");
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [masterDataManagerOpen, setMasterDataManagerOpen] = useState(false);
  const [conversionContext, setConversionContext] = useState(null);
  const [mappingSessionReady, setMappingSessionReady] = useState(false);
  const [masterDataState, setMasterDataState] = useState(null);
  const [conversionMode, setConversionMode] = useState("mapping");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionPatchSet, setCorrectionPatchSet] = useState(null);
  const [correctionSimulation, setCorrectionSimulation] = useState(null);
  const [correctionError, setCorrectionError] = useState("");
  const [lastAppliedRevision, setLastAppliedRevision] = useState(null);
  const [comparisonFiles, setComparisonFiles] = useState([]);
  const [reconciliationReport, setReconciliationReport] = useState(null);

  const inputRef = useRef(null);
  const conversionIdempotencyKeyRef = useRef("");
  const mappingTableRef = useRef(null);
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
  const mappingSource = analyzePayload?.mapping_suggestion?.source;
  const confidence = analyzePayload?.mapping_suggestion?.confidence;
  const visibleAiStatus = analyzePayload?.ai || aiStatus;
  const aiStatusCopy = describeAiStatus(visibleAiStatus);
  const aiStatusUnavailable =
    visibleAiStatus?.gateway === "offline" || visibleAiStatus?.mapping === "failed";
  const converterSteps = useMemo(() => getConverterSteps(capabilities), [capabilities]);
  const profileV2Match = extractProfileMatch(analyzePayload);
  const anomalyResult = operationSession.results.anomaly || {};
  const anomalyIssues = anomalyResult.issues || anomalyResult.items || [];
  const sessionReady = Boolean(operationSession.session?.sessionId);
  const operationsReady = sessionReady && mappingSessionReady;
  const extendedFeaturesEnabled = Boolean(
    capabilities.mapping_profile_v2 ||
    capabilities.anomaly_detection ||
    capabilities.bulk_correction ||
    capabilities.reconciliation ||
    capabilities.accounting_assistant,
  );
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
          return {
            header,
            value: rawHeader
              ? rawHeader
              : formula
                ? `Công thức tự động: ${formula}`
                : defaultValue !== undefined && defaultValue !== ""
                  ? `Giá trị mặc định: ${defaultValue}`
                  : "Chưa thiết lập",
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
    confidence !== undefined ? ` · Khớp ${Math.round(confidence * 100)}%` : "";

  const stepIndex =
    convStatus === STATUS.SUCCESS || convStatus === STATUS.DOWNLOADING
      ? converterSteps.length - 1
      : convStatus === STATUS.PREVIEW
        ? 2
        : convStatus === STATUS.MAPPING
          ? 1
          : 0;

  const hasReadinessBlockers = (readinessReport?.summary?.blocker || 0) > 0;
  const hasUnacknowledgedWarnings =
    (readinessReport?.summary?.warning || 0) > 0 && !acknowledgeWarnings;
  const downloadDisabledByReadiness =
    readinessLoading || hasReadinessBlockers || hasUnacknowledgedWarnings;

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
    setConfirmedProfile(null);
    setMappingSessionReady(false);
    setConversionContext(null);
    setMasterDataState(null);
    setCorrectionOpen(false);
    setCorrectionPatchSet(null);
    setCorrectionSimulation(null);
    setCorrectionError("");
    setLastAppliedRevision(null);
    setComparisonFiles([]);
    setReconciliationReport(null);
    operationSession.resetSession();
  };

  const clearPreviewAfterMappingChange = () => {
    setPreviewHeaders([]);
    setPreviewRows([]);
    setReadinessReport(null);
    setAcknowledgeWarnings(false);
    setConfirmedProfile(null);
    setMappingSessionReady(false);
    if (convStatus === STATUS.PREVIEW || convStatus === STATUS.SUCCESS) {
      setConvStatus(STATUS.MAPPING);
    }
  };

  const focusTargetRow = (target, sourceText = "") => {
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
      const context = selectedWorkspaceId
        ? await createConversionContext(selectedWorkspaceId)
        : extendedFeaturesEnabled
          ? await createPersonalConversionContext()
          : null;
      setConversionContext(context);
      conversionIdempotencyKeyRef.current =
        globalThis.crypto?.randomUUID?.() ||
        `conversion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const result = await analyzeFile(
        file,
        templateId,
        context?.contextToken || null,
        useAiMapping,
        conversionIdempotencyKeyRef.current,
      );
      const suggestion = result.mapping_suggestion || {};
      setAnalyzePayload(result);
      setConversionContext((current) => ({
        ...(current || context || {}),
        contextToken: result.contextToken,
      }));
      setMappingSessionReady(false);
      setTargetTemplateId(result.target_template_id || templateId);
      setTargetMapping(rawMappingToTargetMapping(suggestion.mapping));
      setDefaults(suggestion.defaults || {});
      setFormulas(suggestion.formulas || {});
      setWarnings((suggestion.warnings || []).map(displayMappingWarning));
      setIssues(result.issues || []);
      setMasterDataState(result.master_data || null);
      operationSession.setAnalysis(result);
      setConvStatus(STATUS.MAPPING);
    } catch (err) {
      console.error("[ConvertPage] Analyze failed:", err);
      setErrorMsg(err.message || "Không thể phân tích file.");
      setConvStatus(STATUS.ERROR);
    }
  }

  const buildMappingPayload = (
    contextToken = conversionContext?.contextToken || null,
    sessionOverride = operationSession.session,
  ) => {
    const payload = {
      upload_id: analyzePayload?.upload_id,
      target_template_id: targetTemplateId,
      mapping: targetMappingToRawMapping(targetMapping),
      defaults,
      formulas,
      conversion_context_token: contextToken,
    };
    if (sessionOverride) {
      payload.session_id = sessionOverride.sessionId;
      payload.revision = sessionOverride.revision;
      payload.state_hash = sessionOverride.stateHash;
    }
    return payload;
  };

  const buildReadinessPayload = (
    contextToken = conversionContext?.contextToken || null,
    sessionOverride = operationSession.session,
  ) => buildMappingPayload(contextToken, sessionOverride);

  const refreshConversionContext = async ({ required = false } = {}) => {
    if (!selectedWorkspaceId) {
      if (!required && !conversionContext?.contextToken) return null;
      const context = await createPersonalConversionContext();
      setConversionContext(context);
      return context?.contextToken || null;
    }
    const context = await createConversionContext(selectedWorkspaceId);
    setConversionContext(context);
    return context?.contextToken || null;
  };

  const runReadinessCheck = async (contextToken = null, sessionOverride = null) => {
    if (!analyzePayload?.upload_id) return null;
    setReadinessLoading(true);
    try {
      const token = contextToken ?? (await refreshConversionContext());
      const report = await checkReadiness(
        buildReadinessPayload(token, sessionOverride || operationSession.session),
      );
      setReadinessReport(report);
      setMasterDataState(report.master_data || null);
      if ((report?.summary?.warning || 0) === 0) {
        setAcknowledgeWarnings(false);
      }
      return report;
    } finally {
      setReadinessLoading(false);
    }
  };

  const createPreview = async (contextToken = null) => {
    const token = contextToken ?? (await refreshConversionContext());
    let syncedSession = operationSession.session;
    if (sessionReady) {
      const syncResult = await syncMappingSession(buildMappingPayload(token));
      operationSession.syncSession(syncResult);
      syncedSession = {
        sessionId: syncResult.session.session_id,
        revision: syncResult.session.active_revision,
        stateHash: syncResult.session.state_hash,
      };
      setMappingSessionReady(true);
    }
    const result = await previewMapping(buildMappingPayload(token, syncedSession));
    setPreviewHeaders(result.headers || []);
    setPreviewRows(result.rows || []);
    setIssues(result.issues || []);
    setMasterDataState(result.master_data || null);
    await runReadinessCheck(token, syncedSession);
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
        await runReadinessCheck();
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

  const saveProfileIfNeeded = async (contextToken = null) => {
    // Re-confirm the current mapping before export. Auto-suggested profiles can
    // be repaired by heuristic, and user edits must never export stale profile data.
    const result = await confirmMapping({
      ...buildMappingPayload(contextToken),
      profile_name: selectedTemplate?.label || "Thiết lập ghép cột",
    });
    const confirmed = getConfirmedProfilePresentation(result);
    setConfirmedProfile(confirmed);
    if (result.session) operationSession.syncSession(result);
    return {
      profileId: result.profile_id,
      session: result.session || null,
      profileBinding: confirmed,
    };
  };

  const handleDownload = async () => {
    if (!analyzePayload?.upload_id) return;
    setConvStatus(STATUS.DOWNLOADING);
    setErrorMsg("");
    try {
      const contextToken = await refreshConversionContext({
        required: extendedFeaturesEnabled,
      });
      if (!previewRows.length) {
        const preview = await createPreview(contextToken);
        if (!(preview.rows || []).length) {
          throw new Error("Không có dòng dữ liệu để tải.");
        }
      }
      const readiness = await runReadinessCheck(contextToken);
      if ((readiness?.summary?.blocker || 0) > 0) {
        throw new Error("Còn lỗi cần sửa trước khi tải file MISA.");
      }
      if ((readiness?.summary?.warning || 0) > 0 && !acknowledgeWarnings) {
        throw new Error(
          "Vui lòng rà soát và xác nhận các cảnh báo trước khi tải file MISA.",
        );
      }
      const savedProfile = await saveProfileIfNeeded(contextToken);
      const exportSession = savedProfile.session
        ? {
            sessionId: savedProfile.session.session_id,
            revision: savedProfile.session.active_revision,
            stateHash: savedProfile.session.state_hash,
          }
        : operationSession.session;
      const { blob, filename } = await exportConfirmed(
        analyzePayload.upload_id,
        savedProfile.profileId,
        acknowledgeWarnings,
        exportSession,
        extendedFeaturesEnabled,
        savedProfile.profileBinding,
        analyzePayload.runId || analyzePayload.conversionRunId,
        conversionIdempotencyKeyRef.current,
        analyzePayload.target_template_id || targetTemplateId,
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
      // Cập nhật lại lượt (đã bị trừ ở server) để badge hiển thị đúng.
      refreshUser?.().catch(() => {});
    } catch (err) {
      console.error("[ConvertPage] Download failed:", err);
      if (err.payload?.issues) {
        setReadinessReport(err.payload);
      }
      setErrorMsg(err.message || "Không thể tải file.");
      setConvStatus(previewRows.length ? STATUS.PREVIEW : STATUS.MAPPING);
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

  const handleConfirmMasterDataAlias = async (resolution, targetCode) => {
    if (!selectedWorkspaceId) return;
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

  const requireSession = () => {
    if (operationSession.session?.sessionId && operationSession.mutationContext) {
      return operationSession.session;
    }
    throw new Error(
      "Phiên chuyển đổi mở rộng chưa sẵn sàng. Vui lòng phân tích lại file.",
    );
  };

  const requireOperationAccess = async () => {
    const session = requireSession();
    const contextToken = await refreshConversionContext({ required: true });
    return { session, contextToken };
  };

  const handleOperationFailure = async (operation, error, options = {}) => {
    operationSession.failOperation(operation, error, options);
    if (Number(error?.status || 0) !== 409 || !operationSession.session?.sessionId) {
      return;
    }
    try {
      const contextToken = await refreshConversionContext({ required: true });
      const latest = await getSessionRevisions(
        operationSession.session.sessionId,
        contextToken,
      );
      operationSession.syncSession(latest);
      setMappingSessionReady(false);
      setPreviewHeaders([]);
      setPreviewRows([]);
      setReadinessReport(null);
      setAcknowledgeWarnings(false);
      setConvStatus(STATUS.MAPPING);
    } catch (recoveryError) {
      console.error("[ConvertPage] Stale session recovery failed:", recoveryError);
    }
  };

  const handleDetectAnomalies = async () => {
    operationSession.startOperation("anomaly");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await detectAnomalies(
        session.sessionId,
        {
          ...operationSession.mutationContext,
        },
        contextToken,
      );
      operationSession.finishOperation(
        "anomaly",
        result,
        "Đã hoàn tất kiểm tra bất thường dữ liệu.",
      );
    } catch (error) {
      await handleOperationFailure("anomaly", error);
    }
  };

  const handleReviewAnomaly = async (issue) => {
    operationSession.startOperation("anomaly");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await reviewAnomaly(
        session.sessionId,
        issue.id,
        buildAnomalyReviewPayload(operationSession.mutationContext),
        contextToken,
      );
      const nextIssues = anomalyIssues.map((item) =>
        item.id === issue.id
          ? { ...item, reviewed: true, review_action: result.action }
          : item,
      );
      operationSession.finishOperation(
        "anomaly",
        { ...anomalyResult, issues: nextIssues },
        "Đã đánh dấu bất thường là đã kiểm tra.",
      );
    } catch (error) {
      await handleOperationFailure("anomaly", error);
    }
  };

  const handleOpenBulkCorrection = async () => {
    setCorrectionError("");
    operationSession.startOperation("correction");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await proposeCorrections(
        session.sessionId,
        {
          ...operationSession.mutationContext,
        },
        contextToken,
      );
      setCorrectionPatchSet(result);
      setCorrectionSimulation(null);
      setCorrectionOpen(true);
      operationSession.finishOperation("correction", result);
    } catch (error) {
      setCorrectionError(error.message || "Không thể tạo đề xuất sửa hàng loạt.");
      await handleOperationFailure("correction", error);
    }
  };

  const handleSimulateCorrections = async (selectedIds) => {
    setCorrectionError("");
    operationSession.startOperation("correction");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await simulateCorrections(
        session.sessionId,
        buildCorrectionPayload(
          operationSession.mutationContext,
          correctionPatchSet,
          selectedIds,
        ),
        contextToken,
      );
      setCorrectionSimulation(result);
      operationSession.finishOperation("correction", result);
    } catch (error) {
      setCorrectionError(error.message || "Không thể xem trước thay đổi.");
      await handleOperationFailure("correction", error);
      throw error;
    }
  };

  const handleApplyCorrections = async (selectedIds, acknowledged) => {
    setCorrectionError("");
    operationSession.startOperation("correction");
    try {
      const { session, contextToken } = await requireOperationAccess();
      if (acknowledged !== true && correctionSimulation?.requires_acknowledgement) {
        throw new Error("Cần xác nhận các thay đổi cần rà soát trước khi áp dụng.");
      }
      const idempotencyKey =
        globalThis.crypto?.randomUUID?.() ||
        `correction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const result = await applyCorrections(
        session.sessionId,
        buildCorrectionPayload(
          operationSession.mutationContext,
          correctionPatchSet,
          selectedIds,
        ),
        contextToken,
        idempotencyKey,
      );
      operationSession.finishOperation(
        "correction",
        result,
        "Đã áp dụng thay đổi và tạo phiên bản dữ liệu mới.",
      );
      setLastAppliedRevision({
        revision: Number(
          result.active_revision ?? result.revision ?? session.revision + 1,
        ),
        parentRevision: session.revision,
      });
      setPreviewRows([]);
      setReadinessReport(result.validation || null);
      setAcknowledgeWarnings(false);
      setCorrectionOpen(false);
    } catch (error) {
      setCorrectionError(error.message || "Không thể áp dụng thay đổi.");
      await handleOperationFailure("correction", error);
      throw error;
    }
  };

  const handleUndoCorrection = async () => {
    setCorrectionError("");
    operationSession.startOperation("correction");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const idempotencyKey =
        globalThis.crypto?.randomUUID?.() ||
        `undo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const result = await undoCorrections(
        session.sessionId,
        {
          ...operationSession.mutationContext,
          patch_set_id: correctionPatchSet?.patch_set_id,
        },
        contextToken,
        idempotencyKey,
      );
      operationSession.finishOperation(
        "correction",
        result,
        `Đã hoàn tác correction về phiên bản ${result.revision}.`,
      );
      setReadinessReport(null);
      setLastAppliedRevision(null);
      setCorrectionOpen(false);
    } catch (error) {
      setCorrectionError(error.message || "Không thể hoàn tác thay đổi.");
      await handleOperationFailure("correction", error);
    }
  };

  const handleAddComparisonFile = async (file, role) => {
    operationSession.startOperation("reconciliation");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await addComparisonFile(
        session.sessionId,
        file,
        role,
        operationSession.mutationContext,
        contextToken,
      );
      setComparisonFiles((current) => [...current, result]);
      operationSession.finishOperation("reconciliation", result);
    } catch (error) {
      await handleOperationFailure("reconciliation", error, { optional: true });
    }
  };

  const handleRemoveComparisonFile = async (file) => {
    operationSession.startOperation("reconciliation");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await removeComparisonFile(
        session.sessionId,
        file.id || file.file_id,
        operationSession.mutationContext,
        contextToken,
      );
      setComparisonFiles((current) =>
        current.filter(
          (item) => (item.id || item.file_id) !== (file.id || file.file_id),
        ),
      );
      setReconciliationReport(null);
      operationSession.finishOperation("reconciliation", result);
    } catch (error) {
      await handleOperationFailure("reconciliation", error, { optional: true });
    }
  };

  const handleRunReconciliation = async () => {
    operationSession.startOperation("reconciliation");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await runReconciliation(
        session.sessionId,
        { ...operationSession.mutationContext },
        contextToken,
      );
      setReconciliationReport(result);
      operationSession.finishOperation(
        "reconciliation",
        result,
        "Đã hoàn tất đối chiếu các nguồn được cung cấp.",
      );
    } catch (error) {
      await handleOperationFailure("reconciliation", error, { optional: true });
    }
  };

  const handleConfirmReconciliationCandidate = async (
    record,
    comparisonRecordId = null,
    action = "confirm",
  ) => {
    operationSession.startOperation("reconciliation");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const reportId = reconciliationReport?.report_id;
      const result = await confirmReconciliationMatch(
        session.sessionId,
        reportId,
        record.match_id,
        {
          ...operationSession.mutationContext,
          comparison_record_id: comparisonRecordId,
          action,
        },
        contextToken,
      );
      setReconciliationReport((current) => ({
        ...current,
        status: result.report_status || current?.status,
        records: (current?.records || []).map((item) =>
          item.match_id === result.match_id ? result : item,
        ),
        summary: result.report_summary || current?.summary || {},
      }));
      operationSession.finishOperation("reconciliation", result);
    } catch (error) {
      await handleOperationFailure("reconciliation", error, { optional: true });
    }
  };

  const handleEvidenceNavigation = (evidence) => {
    const target = evidence?.field || evidence?.target_field;
    if (target && targetHeaders.includes(target)) {
      focusTargetRow(target, evidence.message || "");
    }
  };

  const handleAskAccountingQuestion = async (question) => {
    operationSession.startOperation("assistant");
    try {
      const { session, contextToken } = await requireOperationAccess();
      const result = await askAccountingQuestion(
        session.sessionId,
        buildAssistantQuestionPayload(
          operationSession.mutationContext,
          question,
          capabilities.ai_explanation && aiOnline === true,
        ),
        contextToken,
      );
      operationSession.finishOperation("assistant", result);
      return result;
    } catch (error) {
      await handleOperationFailure("assistant", error, { optional: true });
      throw error;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />
      <ConversionModeTabs value={conversionMode} onChange={setConversionMode} />

      <main
        className={`flex-1 sm:pb-0 ${
          capabilities.accounting_assistant && operationsReady ? "pb-32" : "pb-20"
        }`}
      >
        {conversionMode === "reconstruction" && RECONSTRUCTION_ENABLED ? (
          <SmartReconstructionPanel
            templates={templates}
            serviceOnline={serviceOnline}
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
              <StepProgress steps={converterSteps} current={stepIndex} />

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
                  {visibleAiStatus && (
                    <p
                      className={`flex items-center gap-1.5 text-xs ${
                        aiStatusUnavailable ? "text-amber-700" : "text-violet-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          aiStatusUnavailable ? "bg-amber-400" : "bg-violet-500"
                        }`}
                      />
                      {aiStatusCopy}
                    </p>
                  )}
                </div>
              )}

              {serviceOnline === true && aiStatus?.gateway === "online" && (
                <label className="mx-auto mb-5 flex max-w-xl cursor-pointer items-start gap-3 rounded-2xl border border-violet-100 bg-violet-50/70 px-4 py-3 text-left text-sm text-violet-950 shadow-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-violet-300 accent-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
                    checked={useAiMapping}
                    onChange={(event) => setUseAiMapping(event.target.checked)}
                  />
                  <span>
                    <span className="block font-semibold">Dùng AI hỗ trợ ghép cột</span>
                    <span className="mt-0.5 block text-xs text-violet-700">
                      Chỉ gửi tên cột và mẫu dữ liệu đã ẩn danh. Nếu AI không khả dụng,
                      hệ thống tự dùng heuristic an toàn.
                    </span>
                  </span>
                </label>
              )}

              {analyzePayload && sessionReady && extendedFeaturesEnabled && (
                <section
                  aria-label="Thông tin phiên chuyển đổi"
                  className="mb-5 grid gap-2 rounded-2xl border border-blue-100 bg-gradient-to-r from-white to-blue-50/70 p-4 text-sm shadow-sm sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      File
                    </p>
                    <p className="mt-1 truncate font-semibold text-slate-900">
                      {selectedFile?.name}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      Template
                    </p>
                    <p className="mt-1 truncate font-semibold text-slate-900">
                      {selectedTemplate?.label || targetTemplateId}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      Phiên bản dữ liệu
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {operationSession.session.revision}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      Dịch vụ mở rộng
                    </p>
                    <p
                      className={`mt-1 font-semibold ${capabilitiesOnline === false ? "text-amber-700" : "text-emerald-700"}`}
                    >
                      {capabilitiesOnline === false ? "Tạm thời gián đoạn" : "Sẵn sàng"}
                    </p>
                  </div>
                </section>
              )}

              {analyzePayload && extendedFeaturesEnabled && !sessionReady && (
                <Alert
                  variant="warning"
                  title="Tính năng mở rộng chưa sẵn sàng"
                  className="mb-5"
                >
                  Luồng ghép cột, xem trước và tải MISA hiện tại vẫn hoạt động. Phân
                  tích lại file sau khi converter hỗ trợ phiên dữ liệu có version.
                </Alert>
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
                        <button
                          type="button"
                          className="btn-secondary w-full justify-center py-3"
                          onClick={handleReadinessCheck}
                          disabled={
                            convStatus === STATUS.DOWNLOADING ||
                            convStatus === STATUS.ANALYZING ||
                            readinessLoading
                          }
                        >
                          {readinessLoading ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle size={16} />
                          )}
                          Kiểm tra lỗi
                        </button>
                        <button
                          type="button"
                          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-700 hover:shadow-md active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                          onClick={handleDownload}
                          disabled={
                            convStatus === STATUS.DOWNLOADING ||
                            convStatus === STATUS.ANALYZING ||
                            downloadDisabledByReadiness ||
                            (!canConvert && convStatus !== STATUS.SUCCESS)
                          }
                        >
                          {convStatus === STATUS.DOWNLOADING ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <Download size={16} />
                          )}
                          {convStatus === STATUS.SUCCESS
                            ? "Tải lại file kết quả"
                            : "Tải file kết quả"}
                        </button>
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
                  <div className="sr-only" aria-live="polite" aria-atomic="true">
                    {operationSession.announcement}
                  </div>

                  {convStatus === STATUS.ERROR && errorMsg && (
                    <Alert variant="error" className="text-left">
                      {errorMsg}
                    </Alert>
                  )}

                  {operationSession.notice?.kind === "stale_revision" && (
                    <Alert
                      variant="warning"
                      title="Dữ liệu đã có phiên bản mới"
                      className="text-left"
                    >
                      {operationSession.notice.message} Đóng thao tác đang mở rồi chạy
                      lại để tránh ghi đè thay đổi mới hơn.
                    </Alert>
                  )}
                  {operationSession.notice?.kind === "expired_session" && (
                    <Alert
                      variant="warning"
                      title="Phiên dữ liệu đã hết hạn"
                      className="text-left"
                    >
                      Tải lại file nguồn để tạo phiên mới. EzFormat không dùng lại bằng
                      chứng hoặc kết quả từ phiên đã hết hạn.
                    </Alert>
                  )}
                  {operationSession.notice?.kind === "permission_denied" && (
                    <Alert
                      variant="error"
                      title="Không có quyền với phiên này"
                      className="text-left"
                    >
                      Chuyển về đúng workspace hoặc liên hệ quản trị viên. Không có dữ
                      liệu nào được thay đổi.
                    </Alert>
                  )}
                  {operationSession.notice?.kind === "optional_service_offline" && (
                    <Alert
                      variant="warning"
                      title="Dịch vụ tùy chọn đang gián đoạn"
                      className="text-left"
                    >
                      {operationSession.notice.message} Luồng chuyển đổi chính vẫn tiếp
                      tục hoạt động.
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

                      {capabilities.mapping_profile_v2 && sessionReady && (
                        <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
                          <MappingProfileV2Card
                            profileMatch={profileV2Match}
                            serviceOnline={capabilitiesOnline !== false}
                            busy={convStatus === STATUS.ANALYZING}
                            onUse={handlePreview}
                          />
                        </div>
                      )}

                      {confirmedProfile && (
                        <div
                          className={`border-b px-5 py-3 text-sm sm:px-6 ${
                            confirmedProfile.kind === "v2"
                              ? "border-emerald-100 bg-emerald-50 text-emerald-900"
                              : "border-amber-100 bg-amber-50 text-amber-900"
                          }`}
                          role="status"
                        >
                          <p className="font-bold">{confirmedProfile.label}</p>
                          {confirmedProfile.kind === "v2" ? (
                            <p className="mt-1 text-xs">
                              Phiên bản {confirmedProfile.version} · State hash đã khóa
                              cho lần tải này.
                            </p>
                          ) : (
                            <p className="mt-1 text-xs">
                              V2 chưa khả dụng; hệ thống dùng fallback V1 minh bạch.
                            </p>
                          )}
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
                              {mappingConfidenceLabel}
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

                      {(readinessReport || readinessLoading) && (
                        <div className="space-y-3 border-b border-gray-100 bg-white px-5 py-4 sm:px-6">
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
                            {targetHeaders.map((target) => {
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
                                    isHighlighted ? "bg-amber-50/80" : "bg-white"
                                  }`}
                                >
                                  <td className="px-4 py-3 font-semibold text-gray-800">
                                    {target}
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
                              <button
                                type="button"
                                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-700 hover:shadow-md active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                                onClick={handleDownload}
                                disabled={
                                  convStatus === STATUS.DOWNLOADING ||
                                  downloadDisabledByReadiness
                                }
                              >
                                {convStatus === STATUS.DOWNLOADING ? (
                                  <Loader2 size={16} className="animate-spin" />
                                ) : (
                                  <Download size={16} />
                                )}
                                Tải file kết quả
                              </button>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
                            <PreviewTable
                              headers={previewHeaders}
                              rows={previewRows}
                              onCellChange={
                                sessionReady ? undefined : handlePreviewCellChange
                              }
                              onDeleteRow={
                                sessionReady ? undefined : handlePreviewRowDelete
                              }
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

                  {capabilities.anomaly_detection && operationsReady && analyzePayload && (
                    <AnomalyWorkspace
                      issues={anomalyIssues}
                      loading={operationSession.operations.anomaly === "loading"}
                      status={anomalyResult.status || "idle"}
                      onDetect={handleDetectAnomalies}
                      onReview={handleReviewAnomaly}
                      onEvidence={handleEvidenceNavigation}
                      onBulkCorrect={handleOpenBulkCorrection}
                      bulkCorrectionEnabled={capabilities.bulk_correction}
                    />
                  )}

                  {lastAppliedRevision && (
                    <Alert
                      variant="success"
                      title={`Đã áp dụng thay đổi · Phiên bản ${lastAppliedRevision.revision}`}
                      className="text-left"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>Dữ liệu đã được kiểm tra lại trên phiên bản mới.</span>
                        <button
                          type="button"
                          className="btn-secondary min-h-11 shrink-0"
                          onClick={handleUndoCorrection}
                        >
                          Hoàn tác thay đổi
                        </button>
                      </div>
                    </Alert>
                  )}

                  {capabilities.reconciliation &&
                    operationsReady &&
                    analyzePayload &&
                    (readinessReport || previewRows.length > 0) && (
                      <ReconciliationWorkspace
                        primaryFile={selectedFile}
                        comparisonFiles={comparisonFiles}
                        maxFiles={capabilities.limits.comparison_files ?? 0}
                        report={reconciliationReport}
                        loading={
                          operationSession.operations.reconciliation === "loading"
                        }
                        offline={
                          operationSession.notice?.kind === "optional_service_offline"
                        }
                        onAddFile={handleAddComparisonFile}
                        onRemoveFile={handleRemoveComparisonFile}
                        onRun={handleRunReconciliation}
                        onSkip={() => setReconciliationReport(null)}
                        onEvidence={handleEvidenceNavigation}
                        onConfirmCandidate={handleConfirmReconciliationCandidate}
                      />
                    )}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      <Footer />
      <ChatSupport initialMessages={[{ from: "bot", text: "Coming soon..." }]} />
      {capabilities.bulk_correction && operationsReady && (
        <BulkCorrectionDialog
          open={correctionOpen}
          onOpenChange={setCorrectionOpen}
          patchSet={correctionPatchSet}
          simulation={correctionSimulation}
          loading={operationSession.operations.correction === "loading"}
          error={correctionError}
          stale={operationSession.notice?.kind === "stale_revision"}
          latestRevision={lastAppliedRevision?.revision || null}
          onSimulate={handleSimulateCorrections}
          onApply={handleApplyCorrections}
          onUndo={lastAppliedRevision ? handleUndoCorrection : undefined}
        />
      )}
      {capabilities.accounting_assistant && operationsReady && (
        <AccountingAssistantDrawer
          session={operationSession.session}
          fileName={selectedFile?.name}
          aiOnline={capabilities.ai_explanation ? aiOnline : null}
          onAsk={handleAskAccountingQuestion}
          onEvidence={handleEvidenceNavigation}
        />
      )}
      {workspacesEnabled && (
        <>
          <WorkspaceSetupModal
            open={workspaceSetupOpen}
            onClose={() => setWorkspaceSetupOpen(false)}
            onCreate={createWorkspace}
          />
          <MasterDataManager
            open={masterDataManagerOpen}
            workspace={selectedWorkspace}
            snapshots={snapshots}
            onClose={() => setMasterDataManagerOpen(false)}
            onImport={(type, file) => importCatalog(selectedWorkspaceId, type, file)}
            onActivate={(snapshotId) =>
              activateSnapshot(selectedWorkspaceId, snapshotId)
            }
          />
        </>
      )}
    </div>
  );
};

export default ConvertPage;
