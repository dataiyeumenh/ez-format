import { useState, useRef, useCallback } from "react";
import {
  Plus,
  FileSpreadsheet,
  Loader2,
  Download,
  UploadCloud,
  Pencil,
  MessageCircle,
  X,
  Send,
  CheckCircle,
  Server,
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
  LOADING: "loading",
  PREVIEW: "preview",
  DOWNLOADING: "downloading",
  SUCCESS: "success",
  ERROR: "error",
};

const STEPS = ["Tải file", "Xem trước", "Tải MISA"];
const DEFAULT_CONVERSION_TYPE = "bsn_sales";
const EXCEL_EXT = ["xlsx", "xls"];
const PDF_EXT = ["pdf"];

const ConvertPage = () => {
  const { conversionTypes, serviceOnline, validateAndPreview, exportRows } =
    useConverterApi();

  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [convStatus, setConvStatus] = useState(STATUS.IDLE);
  const [errorMsg, setErrorMsg] = useState("");
  const [conversionType, setConversionType] = useState(DEFAULT_CONVERSION_TYPE);
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([
    { from: "bot", text: "Xin chào! Tôi có thể giúp gì cho bạn?" },
    {
      from: "bot",
      text: "Hỏi về chuyển đổi Excel → MISA, gói dịch vụ hoặc hỗ trợ kỹ thuật.",
    },
  ]);

  const inputRef = useRef(null);

  const stepIndex =
    convStatus === STATUS.PREVIEW || convStatus === STATUS.DOWNLOADING
      ? 1
      : convStatus === STATUS.SUCCESS
        ? 2
        : 0;

  const isPreview = convStatus === STATUS.PREVIEW || convStatus === STATUS.DOWNLOADING;

  const fileExtension = (file) => file?.name?.split(".").pop()?.toLowerCase() ?? "";

  const acceptFile = useCallback((file) => {
    if (!file) return;
    const ext = fileExtension(file);
    if (PDF_EXT.includes(ext)) {
      setErrorMsg(
        "Chưa hỗ trợ PDF. Xuất báo cáo sang Excel (.xlsx) từ phần mềm nguồn rồi tải lại tại đây. Xem thêm: docs/PDF.md trong repo.",
      );
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
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
    setValidationWarnings([]);
  }, []);

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

  const handleConvert = async () => {
    if (!selectedFile || !conversionType) return;
    if (serviceOnline === false) {
      setErrorMsg(
        "Dịch vụ chuyển đổi chưa chạy. Mở terminal và chạy: npm run converter",
      );
      setConvStatus(STATUS.ERROR);
      return;
    }

    setConvStatus(STATUS.LOADING);
    setErrorMsg("");
    setValidationWarnings([]);

    try {
      const result = await validateAndPreview(selectedFile, conversionType);
      setPreviewHeaders(result.headers);
      setPreviewRows(result.rows);
      setValidationWarnings(result.warnings);
      setConvStatus(STATUS.PREVIEW);
    } catch (err) {
      console.error("[ConvertPage] Conversion failed:", err);
      setErrorMsg(
        err.message?.includes("Failed to fetch")
          ? "Không kết nối được máy chủ chuyển đổi. Kiểm tra npm run converter."
          : err.message || "Đã xảy ra lỗi không xác định.",
      );
      setConvStatus(STATUS.ERROR);
    }
  };

  const handleCellChange = (rowIdx, header, value) => {
    setPreviewRows((prev) => {
      const next = [...prev];
      next[rowIdx] = { ...next[rowIdx], [header]: value };
      return next;
    });
  };

  const handleDeleteRow = (rowIdx) => {
    setPreviewRows((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  const handleDownload = async () => {
    if (!previewRows.length) return;
    setConvStatus(STATUS.DOWNLOADING);
    setErrorMsg("");

    try {
      const { blob, filename } = await exportRows(conversionType, previewRows);
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
      setErrorMsg(err.message || "Đã xảy ra lỗi khi tải xuống.");
      setConvStatus(STATUS.PREVIEW);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setValidationWarnings([]);
    setPreviewHeaders([]);
    setPreviewRows([]);
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
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

  const typeOptions =
    conversionTypes.length > 0
      ? conversionTypes
      : [
          {
            id: DEFAULT_CONVERSION_TYPE,
            label: "BSN - Form import bán hàng",
          },
        ];

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />

      <main className="flex-1 pb-20 sm:pb-0">
        {!isPreview && convStatus !== STATUS.SUCCESS && (
          <section className="py-8 sm:py-12 px-4">
            <div className="max-w-3xl mx-auto">
              <StepProgress steps={STEPS} current={stepIndex} />

              <div className="text-center mb-6 sm:mb-8">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
                  Chuyển đổi Excel → MISA
                </h1>
                <p className="text-sm sm:text-base text-gray-500 mt-2 max-w-lg mx-auto">
                  Chọn loại form, tải file bán/mua hàng, xem trước và chỉnh sửa trước
                  khi tải file nhập liệu.
                </p>
              </div>

              {serviceOnline === false && (
                <Alert
                  variant="warning"
                  title="Converter chưa sẵn sàng"
                  className="mb-6"
                >
                  Chạy{" "}
                  <code className="text-xs bg-amber-100/80 px-1 rounded">
                    npm run converter
                  </code>{" "}
                  hoặc{" "}
                  <code className="text-xs bg-amber-100/80 px-1 rounded">
                    npm run desktop
                  </code>{" "}
                  trước khi chuyển đổi.
                </Alert>
              )}

              {serviceOnline === true && (
                <p className="flex items-center justify-center gap-1.5 text-xs text-emerald-700 mb-4">
                  <Server size={14} />
                  Dịch vụ chuyển đổi đang hoạt động
                </p>
              )}

              <Alert variant="info" className="mb-4 text-left text-sm">
                <span className="font-medium">PDF:</span> Phiên bản hiện tại chỉ hỗ trợ{" "}
                <strong>Excel</strong>. Nếu bạn có file PDF, hãy xuất sang .xlsx từ phần
                mềm kế toán/bán hàng trước.
              </Alert>

              {(convStatus === STATUS.IDLE || convStatus === STATUS.ERROR) && (
                <>
                  <div
                    className={`relative border-2 border-dashed rounded-2xl p-6 sm:p-10 cursor-pointer transition-all duration-300 ${
                      dragActive
                        ? "border-primary-500 bg-primary-50/80 scale-[1.01] shadow-glow"
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
                      {selectedFile ? (
                        <>
                          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg">
                            <FileSpreadsheet size={26} className="text-white" />
                          </div>
                          <div className="w-full max-w-xs">
                            <p className="text-sm font-semibold text-gray-800 truncate text-center">
                              {selectedFile.name}
                            </p>
                            <p className="text-xs text-gray-400 mt-1 text-center">
                              {(selectedFile.size / 1024).toFixed(1)} KB
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
                          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
                            <UploadCloud size={28} className="text-gray-400" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-800 text-center">
                              Kéo thả file Excel vào đây
                            </p>
                            <p className="text-xs text-gray-400 mt-1 text-center">
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

                  {convStatus === STATUS.ERROR && errorMsg && (
                    <Alert variant="error" className="mt-4 text-left">
                      {errorMsg}
                    </Alert>
                  )}

                  {validationWarnings.length > 0 && convStatus !== STATUS.ERROR && (
                    <Alert
                      variant="warning"
                      title="Cảnh báo dữ liệu"
                      className="mt-4 text-left"
                    >
                      <ul className="list-disc pl-4 space-y-0.5">
                        {validationWarnings.slice(0, 5).map((w, i) => (
                          <li key={w.code ? `${w.code}-${i}` : i}>{w.message}</li>
                        ))}
                      </ul>
                    </Alert>
                  )}

                  {selectedFile && (
                    <div className="mt-5 space-y-3 animate-fade-in">
                      <label className="block text-sm font-medium text-gray-700">
                        Loại form MISA
                        <select
                          className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                          value={conversionType}
                          onChange={(e) => setConversionType(e.target.value)}
                        >
                          {typeOptions.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn-primary w-full py-3.5 text-base"
                        onClick={handleConvert}
                        disabled={serviceOnline === false}
                      >
                        <Pencil size={18} />
                        Phân tích &amp; xem trước
                      </button>
                    </div>
                  )}
                </>
              )}

              {convStatus === STATUS.LOADING && (
                <div className="rounded-2xl border border-primary-100 bg-white p-10 sm:p-12 shadow-card flex flex-col items-center gap-4 animate-fade-in">
                  <Loader2 size={40} className="text-primary-500 animate-spin" />
                  <p className="text-sm font-semibold text-gray-800 text-center">
                    Đang kiểm tra và ánh xạ dữ liệu…
                  </p>
                  <p className="text-xs text-gray-400 text-center">
                    File lớn có thể mất vài chục giây.
                  </p>
                </div>
              )}

              <p className="text-center mt-6 text-xs text-gray-400">
                <Link to="/" className="text-primary-600 hover:underline">
                  ← Về trang chủ
                </Link>
              </p>
            </div>
          </section>
        )}

        {convStatus === STATUS.SUCCESS && (
          <section className="py-12 sm:py-16 px-4 animate-fade-in">
            <div className="max-w-md mx-auto rounded-2xl border border-emerald-100 bg-white p-8 sm:p-10 shadow-card flex flex-col items-center gap-4 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle size={32} className="text-emerald-600" />
              </div>
              <h2 className="text-lg font-bold text-gray-900">Tải xuống thành công</h2>
              <p className="text-sm text-gray-500">
                File MISA đã được lưu về máy của bạn.
              </p>
              <button
                type="button"
                className="btn-secondary w-full sm:w-auto"
                onClick={handleReset}
              >
                <Plus size={16} />
                Chuyển đổi file khác
              </button>
            </div>
          </section>
        )}

        {isPreview && (
          <section className="py-4 sm:py-8 px-3 sm:px-4 max-w-[100vw] animate-fade-in">
            <div className="max-w-6xl mx-auto">
              <StepProgress steps={STEPS} current={1} />

              <div className="mb-4 sm:mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-lg sm:text-xl font-bold text-gray-900 flex items-center gap-2">
                    <Pencil size={18} className="text-primary-600 shrink-0" />
                    Xem trước &amp; chỉnh sửa
                  </h2>
                  <p className="text-xs sm:text-sm text-gray-500 mt-1">
                    {previewRows.length} dòng · {previewHeaders.length} cột
                  </p>
                </div>
                <div className="flex flex-col xs:flex-row gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="btn-secondary w-full sm:w-auto order-2 sm:order-1"
                  >
                    Tải file khác
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={convStatus === STATUS.DOWNLOADING || !previewRows.length}
                    className="btn-primary w-full sm:w-auto order-1 sm:order-2"
                  >
                    {convStatus === STATUS.DOWNLOADING ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Download size={16} />
                    )}
                    Tải MISA Excel
                  </button>
                </div>
              </div>

              {validationWarnings.length > 0 && (
                <Alert variant="warning" title="Cảnh báo" className="mb-4 text-sm">
                  {validationWarnings.length} cảnh báo — vẫn có thể tải sau khi rà soát.
                </Alert>
              )}

              {errorMsg && (
                <Alert variant="error" className="mb-4">
                  {errorMsg}
                </Alert>
              )}

              <PreviewTable
                headers={previewHeaders}
                rows={previewRows}
                onCellChange={handleCellChange}
                onDeleteRow={handleDeleteRow}
                disabled={convStatus === STATUS.DOWNLOADING}
              />

              <div className="mt-4 sm:mt-5 flex justify-stretch sm:justify-end">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={convStatus === STATUS.DOWNLOADING || !previewRows.length}
                  className="btn-primary w-full sm:w-auto sm:px-8"
                >
                  {convStatus === STATUS.DOWNLOADING ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}
                  Tải xuống ({previewRows.length} dòng)
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      <Footer />

      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col items-end gap-3 max-w-[calc(100vw-2rem)]">
        {chatOpen && (
          <div className="w-full min-w-[280px] max-w-[20rem] sm:w-80 bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden animate-slide-up">
            <div className="bg-gradient-to-r from-primary-600 to-primary-700 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center shrink-0">
                  <MessageCircle size={16} className="text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-white font-semibold text-sm truncate">EzFormat</p>
                  <p className="text-primary-200 text-xs">Hỗ trợ nhanh</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                className="text-white/80 hover:text-white p-1 shrink-0"
              >
                <X size={18} />
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
