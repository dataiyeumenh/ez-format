import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  FileQuestion,
  FileSpreadsheet,
  Loader2,
  LockKeyhole,
  UploadCloud,
  WifiOff,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import ExplanationInspector from "../components/student/ExplanationInspector";
import FileQuestionPanel from "../components/student/FileQuestionPanel";
import CheckWorkPanel from "../components/student/CheckWorkPanel";
import AccountingMapPanel from "../components/student/AccountingMapPanel";
import InternshipAssistantPanel from "../components/student/InternshipAssistantPanel";
import ReconciliationPanel from "../components/student/ReconciliationPanel";
import StudentMappingTable from "../components/student/StudentMappingTable";
import StudentSessionSummary from "../components/student/StudentSessionSummary";
import SourceRowPanel from "../components/student/SourceRowPanel";
import {
  fetchStudentAssistantStatus,
  studentAccountingMapEnabled,
  studentCheckWorkEnabled,
  studentFileQaEnabled,
  studentInternshipEnabled,
  studentReconciliationEnabled,
  STUDENT_TEMPLATE_OPTIONS,
  useStudentAssistantApi,
} from "../hooks/useStudentAssistantApi";
import {
  classifyStudentAssistantError,
  buildStudentAttemptSubmission,
  createStudentWorkDraft,
  clearStudentSessionResume,
  createStudentSourceRowRequestContext,
  findStudentExplanation,
  keepCurrentExplanationSelection,
  getNextStudentTabId,
  loadStudentSessionResume,
  resumeStudentSession,
  resolveStudentEvidenceNavigation,
  saveStudentSessionResume,
  studentSourceRowResponseMatchesContext,
} from "../utils/studentAssistant";

function StudentErrorState({ kind, message, onRetry }) {
  const config = {
    expired: {
      icon: FileQuestion,
      title: "Phiên giải thích đã hết hạn",
      copy: "Tạo phiên mới và tải lại file để tiếp tục. File tạm đã được quản lý theo retention.",
    },
    permission: {
      icon: LockKeyhole,
      title: "Không có quyền mở phiên này",
      copy: "Phiên và upload chỉ được mở bằng đúng tài khoản, owner scope và signed context.",
    },
    offline: {
      icon: WifiOff,
      title: "Converter đang ngoại tuyến",
      copy: "Không thể phân tích file lúc này. Phiên Node và dữ liệu của người dùng khác không bị truy cập.",
    },
    request: {
      icon: AlertTriangle,
      title: "Chưa thể phân tích file",
      copy: message || "Kiểm tra file và thử lại.",
    },
  }[kind || "request"];
  const Icon = config.icon;
  return (
    <section className="rounded-3xl border border-amber-200 bg-white p-8 text-center shadow-card">
      <Icon className="mx-auto text-amber-600" size={40} />
      <h2 className="mt-4 text-xl font-black text-gray-950">{config.title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-600">
        {message || config.copy}
      </p>
      <button type="button" onClick={onRetry} className="btn-primary mt-5">
        Thử lại với file mới
      </button>
    </section>
  );
}

export default function StudentAssistantPage() {
  const inputRef = useRef(null);
  const resumeAttemptedRef = useRef(false);
  const {
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
  } = useStudentAssistantApi();
  const [serviceStatus, setServiceStatus] = useState({
    loading: true,
    serviceOnline: null,
    aiStatus: null,
    capabilityEnabled: null,
    questionCapabilityEnabled: null,
    attemptCapabilityEnabled: null,
    accountingMapCapabilityEnabled: null,
    reconciliationCapabilityEnabled: null,
    internshipCapabilityEnabled: null,
  });
  const [file, setFile] = useState(null);
  const [targetTemplateId, setTargetTemplateId] = useState("bsn_sales");
  const [status, setStatus] = useState("empty");
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [selectedExplanationId, setSelectedExplanationId] = useState(null);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [questionHistory, setQuestionHistory] = useState([]);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [questionError, setQuestionError] = useState(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [evidenceNavigation, setEvidenceNavigation] = useState(null);
  const [sourceRowState, setSourceRowState] = useState({ status: "idle" });
  const [activeTab, setActiveTab] = useState("overview");
  const [attemptResult, setAttemptResult] = useState(null);
  const [studentWork, setStudentWork] = useState(null);
  const [attemptHistory, setAttemptHistory] = useState([]);
  const [skillProgress, setSkillProgress] = useState({ skills: {} });
  const [attemptLoading, setAttemptLoading] = useState(false);
  const [attemptError, setAttemptError] = useState("");
  const [revealedLevels, setRevealedLevels] = useState({});
  const [revealedHints, setRevealedHints] = useState({});
  const [accountingMapState, setAccountingMapState] = useState({ data: null, loading: false, error: "" });
  const [reconciliationState, setReconciliationState] = useState({ data: null, loading: false, error: "" });
  const [activityState, setActivityState] = useState({ activities: [], loaded: false, loading: false, error: "" });
  const tabRefs = useRef({});
  const sourceRowRequestRef = useRef(0);
  const sourceRowAbortRef = useRef(null);
  const sourceRowContextRef = useRef(null);
  sourceRowContextRef.current = createStudentSourceRowRequestContext(
    session,
    analysis,
    sourceRowRequestRef.current,
  );

  const refreshAttemptMetadata = useCallback(
    async (activeSession) => {
      const sessionId = activeSession?.session?.id;
      const contextToken = activeSession?.contextToken;
      if (!sessionId || !contextToken || !studentCheckWorkEnabled) return;
      const [historyResult, progressResult] = await Promise.allSettled([
        getAttemptHistory(sessionId, contextToken),
        getSkillProgress(),
      ]);
      if (historyResult.status === "fulfilled") {
        setAttemptHistory(historyResult.value.attempts || []);
      }
      if (progressResult.status === "fulfilled") {
        setSkillProgress(progressResult.value.progress || { skills: {} });
      }
    },
    [getAttemptHistory, getSkillProgress],
  );

  const loadAccountingMap = useCallback(async () => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken) return;
    setAccountingMapState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await getAccountingMap(sessionId, contextToken);
      setAccountingMapState({ data, loading: false, error: "" });
    } catch (requestError) {
      setAccountingMapState({ data: null, loading: false, error: requestError.message });
    }
  }, [getAccountingMap, session]);

  const loadReconciliation = useCallback(async () => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken) return;
    setReconciliationState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await getReconciliation(sessionId, contextToken);
      setReconciliationState({ data, loading: false, error: "" });
    } catch (requestError) {
      setReconciliationState({ data: null, loading: false, error: requestError.message });
    }
  }, [getReconciliation, session]);

  const loadActivities = useCallback(async () => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken) return;
    setActivityState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await getActivities(sessionId, contextToken);
      setActivityState({ activities: data.activities || [], loaded: true, loading: false, error: "" });
    } catch (requestError) {
      setActivityState((current) => ({ ...current, loaded: true, loading: false, error: requestError.message }));
    }
  }, [getActivities, session]);

  useEffect(() => {
    let cancelled = false;
    fetchStudentAssistantStatus().then((nextStatus) => {
      if (!cancelled) setServiceStatus({ loading: false, ...nextStatus });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (resumeAttemptedRef.current) return undefined;
    resumeAttemptedRef.current = true;
    const resume = loadStudentSessionResume(sessionStorage);
    if (!resume) return undefined;

    let cancelled = false;
    setSession(resume);
    setStatus("loading");
    resumeStudentSession(resume, { getOverview, refreshContext })
      .then(({ resume: activeResume, overview }) => {
        if (cancelled) return;
        setSession(activeResume);
        saveStudentSessionResume(sessionStorage, activeResume);
        setAnalysis(overview);
        setStatus("ready");
        refreshAttemptMetadata(activeResume);
      })
      .catch((requestError) => {
        if (cancelled) return;
        const kind = classifyStudentAssistantError(requestError);
        if (kind === "expired" || kind === "permission") {
          clearStudentSessionResume(sessionStorage);
        }
        setError({ kind, message: requestError.message });
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [getOverview, refreshAttemptMetadata, refreshContext]);

  useEffect(() => {
    if (!analysis) return;
    setStudentWork(createStudentWorkDraft(analysis));
    setAttemptResult(null);
    setRevealedLevels({});
    setRevealedHints({});
    setSelectedExplanationId((currentId) => {
      const current = keepCurrentExplanationSelection(
        currentId,
        analysis.explanations,
        analysis.student_state_hash,
      );
      if (current) return current;
      return (
        analysis.explanations.find((item) => item.severity === "blocker")?.id ||
        analysis.explanations.find((item) => item.kind === "mapping")?.id ||
        analysis.explanations[0]?.id ||
        null
      );
    });
  }, [analysis]);

  useEffect(() => {
    if (activeTab === "accounting-map" && !accountingMapState.data && !accountingMapState.loading && !accountingMapState.error) loadAccountingMap();
    if (activeTab === "reconciliation" && !reconciliationState.data && !reconciliationState.loading && !reconciliationState.error) loadReconciliation();
    if (activeTab === "internship" && !activityState.loaded && !activityState.loading) loadActivities();
  }, [
    activeTab,
    accountingMapState.data,
    accountingMapState.error,
    accountingMapState.loading,
    activityState.loaded,
    activityState.loading,
    loadAccountingMap,
    loadActivities,
    loadReconciliation,
    reconciliationState.data,
    reconciliationState.error,
    reconciliationState.loading,
  ]);

  const selectedExplanation = useMemo(
    () =>
      analysis?.explanations?.find((item) => item.id === selectedExplanationId) ||
      null,
    [analysis?.explanations, selectedExplanationId],
  );

  const reset = () => {
    sourceRowRequestRef.current += 1;
    sourceRowAbortRef.current?.abort();
    sourceRowAbortRef.current = null;
    sourceRowContextRef.current = createStudentSourceRowRequestContext(
      null,
      null,
      sourceRowRequestRef.current,
    );
    clearStudentSessionResume(sessionStorage);
    setFile(null);
    setStatus("empty");
    setError(null);
    setSession(null);
    setAnalysis(null);
    setSelectedExplanationId(null);
    setMobileInspectorOpen(false);
    setQuestionHistory([]);
    setQuestionLoading(false);
    setQuestionError(null);
    setLastQuestion("");
    setEvidenceNavigation(null);
    setSourceRowState({ status: "idle" });
    setActiveTab("overview");
    setAttemptResult(null);
    setStudentWork(null);
    setAttemptHistory([]);
    setSkillProgress({ skills: {} });
    setAttemptLoading(false);
    setAttemptError("");
    setRevealedLevels({});
    setRevealedHints({});
    setAccountingMapState({ data: null, loading: false, error: "" });
    setReconciliationState({ data: null, loading: false, error: "" });
    setActivityState({ activities: [], loaded: false, loading: false, error: "" });
    if (inputRef.current) inputRef.current.value = "";
  };

  const acceptFile = (nextFile) => {
    if (!nextFile) return;
    if (!/\.xlsx?$/i.test(nextFile.name)) {
      setError({ kind: "request", message: "Chỉ hỗ trợ file .xls hoặc .xlsx." });
      setStatus("error");
      return;
    }
    setFile(nextFile);
    setError(null);
    setStatus("empty");
  };

  const handleAnalyze = async () => {
    if (!file) {
      inputRef.current?.click();
      return;
    }
    if (serviceStatus.serviceOnline === false || serviceStatus.capabilityEnabled === false) {
      setError({ kind: "offline", message: "Converter Student chưa sẵn sàng." });
      setStatus("error");
      return;
    }
    sourceRowRequestRef.current += 1;
    sourceRowAbortRef.current?.abort();
    sourceRowAbortRef.current = null;
    sourceRowContextRef.current = createStudentSourceRowRequestContext(
      null,
      null,
      sourceRowRequestRef.current,
    );
    setStatus("loading");
    setError(null);
    try {
      const created = await createSession(file);
      setSession(created);
      saveStudentSessionResume(sessionStorage, created);
      const analyzed = await analyzeSession(
        file,
        created.contextToken,
        targetTemplateId,
      );
      setAnalysis(analyzed);
      setStatus("ready");
      refreshAttemptMetadata(created);
    } catch (requestError) {
      const kind = classifyStudentAssistantError(requestError);
      if (kind === "expired" || kind === "permission") {
        clearStudentSessionResume(sessionStorage);
      }
      setError({
        kind,
        message: requestError.message,
      });
      setStatus("error");
    }
  };

  const handleSubmitAttempt = async () => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken || !analysis || !studentWork) return;
    setAttemptLoading(true);
    setAttemptError("");
    try {
      const result = await submitAttempt(sessionId, contextToken, {
        kind: "mapping_attempt",
        state_hash: analysis.student_state_hash,
        submitted: buildStudentAttemptSubmission(analysis, studentWork),
      });
      setAttemptResult(result);
      setSkillProgress(result.progress || { skills: {} });
      setAttemptHistory((history) => [result.attempt, ...history]);
      setRevealedLevels({});
      setRevealedHints({});
    } catch (requestError) {
      setAttemptError(requestError.message);
    } finally {
      setAttemptLoading(false);
    }
  };

  const handleRevealHint = async (issueId, level) => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    const attemptId = attemptResult?.attempt?.id;
    if (!sessionId || !contextToken || !attemptId) return;
    setAttemptLoading(true);
    setAttemptError("");
    try {
      const result = await revealHint(
        sessionId,
        contextToken,
        attemptId,
        issueId,
        level,
      );
      setRevealedLevels((current) => ({
        ...current,
        [issueId]: Math.max(Number(current[issueId] ?? -1), Number(level)),
      }));
      setRevealedHints((current) => ({
        ...current,
        [issueId]: {
          ...(current[issueId] || {}),
          [level]: result.hint,
        },
      }));
    } catch (requestError) {
      setAttemptError(requestError.message);
    } finally {
      setAttemptLoading(false);
    }
  };

  const handleSelectExplanation = (explanation) => {
    setSelectedExplanationId(explanation.id);
    setMobileInspectorOpen(true);
  };

  const handleAskQuestion = async (question) => {
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken) return;
    setQuestionLoading(true);
    setQuestionError(null);
    setLastQuestion(question);
    try {
      const answer = await askQuestion(sessionId, contextToken, question);
      setQuestionHistory((history) => [...history, { question, answer }]);
    } catch (requestError) {
      setQuestionError(requestError.message);
    } finally {
      setQuestionLoading(false);
    }
  };

  const handleEvidenceNavigate = async (evidence) => {
    const navigation = resolveStudentEvidenceNavigation(evidence, analysis);
    setEvidenceNavigation({ ...navigation, key: evidence.id });
    setActiveTab("mapping");
    if (navigation.targetField) {
      const explanation = findStudentExplanation(
        analysis?.explanations || [],
        navigation.targetField,
        {
          preferredKinds: ["issue", "normalization", "mapping", "field"],
          sourceRow: navigation.sourceRow,
          previewRow: navigation.previewRow,
          issueCode: evidence.issue_code || null,
        },
      );
      if (explanation) handleSelectExplanation(explanation);
    }
    if (!navigation.requiresSourceRowFetch) return;
    const sessionId = session?.session?.id;
    const contextToken = session?.contextToken;
    if (!sessionId || !contextToken) return;
    sourceRowAbortRef.current?.abort();
    const requestEpoch = sourceRowRequestRef.current + 1;
    sourceRowRequestRef.current = requestEpoch;
    const abortController = new AbortController();
    sourceRowAbortRef.current = abortController;
    sourceRowContextRef.current = createStudentSourceRowRequestContext(
      session,
      analysis,
      requestEpoch,
    );
    setSourceRowState({
      status: "loading",
      worksheetRow: navigation.sourceRow,
      selectedField: navigation.sourceField,
    });
    try {
      const data = await getSourceRow(
        sessionId,
        contextToken,
        navigation.sourceRow,
        abortController.signal,
      );
      if (
        !studentSourceRowResponseMatchesContext(
          data,
          sourceRowContextRef.current,
          requestEpoch,
        )
      ) return;
      setSourceRowState({
        status: "ready",
        data,
        selectedField: navigation.sourceField,
      });
    } catch (requestError) {
      if (
        abortController.signal.aborted ||
        sourceRowRequestRef.current !== requestEpoch
      ) return;
      setSourceRowState({
        status: "error",
        worksheetRow: navigation.sourceRow,
        selectedField: navigation.sourceField,
        error: requestError.message,
      });
    } finally {
      if (sourceRowAbortRef.current === abortController) {
        sourceRowAbortRef.current = null;
      }
    }
  };

  const tabs = useMemo(() => {
    const items = [
      { id: "overview", label: "Tổng quan" },
      { id: "mapping", label: "Mapping & dữ liệu" },
      { id: "explanations", label: "Giải thích" },
    ];
    if (studentFileQaEnabled && serviceStatus.questionCapabilityEnabled) {
      items.push({ id: "questions", label: "Câu hỏi" });
    }
    if (studentCheckWorkEnabled && serviceStatus.attemptCapabilityEnabled) {
      items.push({ id: "attempts", label: "Bài làm" });
    }
    if (studentAccountingMapEnabled && serviceStatus.accountingMapCapabilityEnabled) {
      items.push({ id: "accounting-map", label: "Accounting Map" });
    }
    if (studentReconciliationEnabled && serviceStatus.reconciliationCapabilityEnabled) {
      items.push({ id: "reconciliation", label: "Reconciliation" });
    }
    if (studentInternshipEnabled && serviceStatus.internshipCapabilityEnabled) {
      items.push({ id: "internship", label: "Internship" });
    }
    return items;
  }, [
    serviceStatus.accountingMapCapabilityEnabled,
    serviceStatus.attemptCapabilityEnabled,
    serviceStatus.internshipCapabilityEnabled,
    serviceStatus.questionCapabilityEnabled,
    serviceStatus.reconciliationCapabilityEnabled,
  ]);

  const handleTabKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextId = getNextStudentTabId(
      tabs.map((tab) => tab.id),
      activeTab,
      event.key,
    );
    setActiveTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-blue-50/50">
      <Navbar />
      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-slate-200 pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-sm font-bold text-blue-800">
              <BookOpenCheck size={16} /> Student Assistant · Phases 1–6
            </span>
            <h1 className="mt-4 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
              Hiểu file kế toán từ chính dữ liệu nguồn
            </h1>
            <p className="mt-3 text-base leading-7 text-gray-600">
              Xem file thuộc mẫu nào, cột nguồn đi vào trường nào, quy tắc nào tạo lỗi
              và bằng chứng nằm ở đâu. Chế độ này vẫn đầy đủ khi AI ngoại tuyến.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span
              className={`rounded-full px-3 py-1.5 ${
                serviceStatus.serviceOnline
                  ? "bg-emerald-100 text-emerald-800"
                  : serviceStatus.loading
                    ? "bg-slate-100 text-slate-600"
                    : "bg-red-100 text-red-800"
              }`}
            >
              Converter: {serviceStatus.loading ? "đang kiểm tra" : serviceStatus.serviceOnline ? "online" : "offline"}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">
              AI: {serviceStatus.aiStatus || "không bắt buộc"}
            </span>
          </div>
        </header>

        {status !== "ready" && (
          <div className="mx-auto mt-8 max-w-4xl">
            {status === "error" ? (
              <StudentErrorState kind={error?.kind} message={error?.message} onRetry={reset} />
            ) : (
              <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-card">
                <div className="grid lg:grid-cols-[1.05fr_0.95fr]">
                  <div className="p-6 sm:p-9">
                    <p className="text-xs font-black uppercase tracking-[0.15em] text-primary-600">
                      Bắt đầu một phiên mới
                    </p>
                    <h2 className="mt-2 text-2xl font-black text-gray-950">
                      Tải file bán hàng hoặc mua hàng
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-gray-500">
                      Node tạo signed session trước; trình duyệt sau đó upload trực tiếp
                      sang converter bằng context của đúng owner.
                    </p>

                    <label className="mt-6 block text-sm font-bold text-gray-800">
                      Mẫu đích
                      <select
                        value={targetTemplateId}
                        onChange={(event) => setTargetTemplateId(event.target.value)}
                        disabled={status === "loading"}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-primary-500"
                      >
                        {STUDENT_TEMPLATE_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <input
                      ref={inputRef}
                      type="file"
                      accept=".xls,.xlsx"
                      className="sr-only"
                      onChange={(event) => acceptFile(event.target.files?.[0])}
                    />
                    <button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      disabled={status === "loading"}
                      className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-left hover:border-primary-400 hover:bg-primary-50"
                    >
                      <span className="rounded-xl bg-white p-2.5 text-primary-600 shadow-sm">
                        <UploadCloud size={22} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-black text-gray-900">
                          {file?.name || "Chọn file Excel"}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">
                          .xls hoặc .xlsx
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={handleAnalyze}
                      disabled={status === "loading" || serviceStatus.loading}
                      className="btn-primary mt-4 w-full py-3"
                    >
                      {status === "loading" ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : (
                        <FileSpreadsheet size={18} />
                      )}
                      {status === "loading" ? "Đang phân tích và dựng bằng chứng…" : "Giải thích file này"}
                    </button>
                  </div>

                  <div className="relative overflow-hidden bg-slate-950 p-6 text-white sm:p-9">
                    <div className="absolute -right-20 -top-16 h-56 w-56 rounded-full bg-blue-500/20 blur-3xl" />
                    <div className="relative">
                      <p className="text-xs font-black uppercase tracking-[0.15em] text-blue-300">
                        Kết quả nhận được
                      </p>
                      <div className="mt-5 space-y-4">
                        {[
                          "Tóm tắt cấu trúc file và mẫu đích",
                          "Mapping, mặc định và công thức đang dùng",
                          "Readiness blocker/warning từ pipeline hiện có",
                          "Inspector dẫn về dòng, cột hoặc rule source",
                        ].map((item, index) => (
                          <div key={item} className="flex gap-3">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black text-blue-200">
                              {index + 1}
                            </span>
                            <p className="text-sm leading-6 text-slate-200">{item}</p>
                          </div>
                        ))}
                      </div>
                      <p className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-5 text-slate-300">
                        Không kết luận “đúng luật 100%” hoặc tự chọn tài khoản/thuế suất khi
                        file không có căn cứ.
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

        {status === "ready" && analysis && (
          <div className="mt-7">
            <div
              role="tablist"
              aria-label="Không gian làm việc Student Assistant"
              onKeyDown={handleTabKeyDown}
              className="flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[tab.id] = node;
                  }}
                  id={`student-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`student-panel-${tab.id}`}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-black transition ${
                    activeTab === tab.id
                      ? "bg-slate-950 text-white"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div
              id={`student-panel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`student-tab-${activeTab}`}
              className="mt-5"
            >
              {activeTab === "overview" && (
                <div className="max-w-xl">
                  <StudentSessionSummary analysis={analysis} session={session} onReset={reset} />
                </div>
              )}

              {activeTab === "mapping" && (
                <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <StudentMappingTable
                    analysis={analysis}
                    studentWork={studentWork}
                    onStudentWorkChange={setStudentWork}
                    selectedId={selectedExplanationId}
                    onSelectExplanation={handleSelectExplanation}
                    evidenceNavigation={evidenceNavigation}
                  />
                  <ExplanationInspector
                    explanation={selectedExplanation}
                    mobileOpen={mobileInspectorOpen}
                    onMobileOpenChange={setMobileInspectorOpen}
                  />
                </div>
              )}

              {activeTab === "explanations" && (
                <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
                    <h2 className="text-xl font-black text-slate-950">Giải thích có bằng chứng</h2>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {(analysis.explanations || []).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleSelectExplanation(item)}
                          className={`rounded-xl border p-3 text-left text-sm ${
                            selectedExplanationId === item.id
                              ? "border-primary-400 bg-primary-50 text-primary-950"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <span className="block font-black">{item.title}</span>
                          <span className="mt-1 block text-xs opacity-70">{item.kind}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <ExplanationInspector
                    explanation={selectedExplanation}
                    mobileOpen={mobileInspectorOpen}
                    onMobileOpenChange={setMobileInspectorOpen}
                  />
                </div>
              )}

              {activeTab === "questions" && (
                <FileQuestionPanel
                  targetTemplateId={analysis.target_template_id}
                  aiStatus={serviceStatus.aiStatus}
                  history={questionHistory}
                  loading={questionLoading}
                  error={questionError}
                  onAsk={handleAskQuestion}
                  onRetry={() => lastQuestion && handleAskQuestion(lastQuestion)}
                  onEvidenceNavigate={handleEvidenceNavigate}
                />
              )}

              {activeTab === "attempts" && (
                <CheckWorkPanel
                  result={attemptResult}
                  progress={skillProgress}
                  history={attemptHistory}
                  loading={attemptLoading}
                  error={attemptError}
                  revealedLevels={revealedLevels}
                  revealedHints={revealedHints}
                  classification={studentWork?.classification || ""}
                  classificationOptions={STUDENT_TEMPLATE_OPTIONS}
                  onClassificationChange={(classification) =>
                    setStudentWork((current) => ({ ...current, classification }))
                  }
                  onSubmit={handleSubmitAttempt}
                  onRevealHint={handleRevealHint}
                />
              )}

              {activeTab === "accounting-map" && (
                <AccountingMapPanel
                  data={accountingMapState.data}
                  loading={accountingMapState.loading}
                  error={accountingMapState.error}
                  onRefresh={loadAccountingMap}
                  onEvidenceNavigate={handleEvidenceNavigate}
                />
              )}

              {activeTab === "reconciliation" && (
                <ReconciliationPanel
                  data={reconciliationState.data}
                  loading={reconciliationState.loading}
                  error={reconciliationState.error}
                  onRefresh={loadReconciliation}
                />
              )}

              {activeTab === "internship" && (
                <InternshipAssistantPanel
                  activities={activityState.activities}
                  loading={activityState.loading}
                  error={activityState.error}
                  onRefresh={loadActivities}
                  onDelete={async () => {
                    await deleteActivities(session.session.id, session.contextToken);
                    setActivityState({ activities: [], loaded: true, loading: false, error: "" });
                  }}
                  onPreview={(fullDocumentNumbers) =>
                    previewAnonymization(
                      session.session.id,
                      session.contextToken,
                      fullDocumentNumbers,
                    )
                  }
                  onExport={async (fullDocumentNumbers) => {
                    const result = await exportAnonymizedWorkbook(
                      session.session.id,
                      session.contextToken,
                      fullDocumentNumbers,
                    );
                    await loadActivities();
                    return result;
                  }}
                  onGenerateReport={(request) =>
                    generateInternshipReport(
                      session.session.id,
                      session.contextToken,
                      request,
                    )
                  }
                />
              )}
            </div>

            <SourceRowPanel
              state={sourceRowState}
              onClose={() => setSourceRowState({ status: "idle" })}
            />
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
