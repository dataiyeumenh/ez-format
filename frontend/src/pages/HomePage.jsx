import { useState, useRef, useCallback } from "react";
import {
  Plus,
  FileSpreadsheet,
  ChevronRight,
  MessageCircle,
  X,
  Send,
  CheckCircle,
  AlertCircle,
  Loader2,
  Download,
  UploadCloud,
  Pencil,
  Trash2,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

// ── Conversion status constants ──────────────────────────────────────────────
const STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  PREVIEW: "preview", // show editable table
  DOWNLOADING: "downloading",
  SUCCESS: "success",
  ERROR: "error",
};

// Build correct API base URL (mirrors api.js logic)
const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : "/api";

const HomePage = () => {
  // ── Upload & conversion state ──────────────────────────────────────────────
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [convStatus, setConvStatus] = useState(STATUS.IDLE);
  const [errorMsg, setErrorMsg] = useState("");
  // Preview / edit state
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewRows, setPreviewRows] = useState([]); // array of row objects

  // ── Chatbot state ──────────────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([
    { from: "bot", text: "Xin chào! Tôi có thể giúp gì cho bạn? 👋" },
    {
      from: "bot",
      text: "Bạn có thể hỏi tôi về cách chuyển đổi file, các gói dịch vụ, hoặc hỗ trợ kỹ thuật.",
    },
  ]);

  const inputRef = useRef(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isValidExcel = (file) => {
    if (!file) return false;
    const ext = file.name.split(".").pop().toLowerCase();
    return ["xlsx", "xls"].includes(ext);
  };

  const acceptFile = useCallback((file) => {
    if (!isValidExcel(file)) {
      setErrorMsg("Chỉ chấp nhận tệp Excel (.xlsx, .xls).");
      setConvStatus(STATUS.ERROR);
      return;
    }
    setSelectedFile(file);
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
  }, []);

  // ── Drag & drop handlers ───────────────────────────────────────────────────

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

  // ── Step 1: Convert – upload file, receive JSON preview ───────────────────

  const handleConvert = async () => {
    if (!selectedFile) return;
    setConvStatus(STATUS.LOADING);
    setErrorMsg("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch(`${baseURL}/convert`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const { headers, rows } = await response.json();
      setPreviewHeaders(headers);
      setPreviewRows(rows);
      setConvStatus(STATUS.PREVIEW);
    } catch (err) {
      console.error("[HomePage] Conversion failed:", err);
      setErrorMsg(err.message || "Đã xảy ra lỗi không xác định.");
      setConvStatus(STATUS.ERROR);
    }
  };

  // ── Step 2: Edit helpers ───────────────────────────────────────────────────

  /** Update a single cell value */
  const handleCellChange = (rowIdx, header, value) => {
    setPreviewRows((prev) => {
      const next = [...prev];
      next[rowIdx] = { ...next[rowIdx], [header]: value };
      return next;
    });
  };

  /** Delete a row */
  const handleDeleteRow = (rowIdx) => {
    setPreviewRows((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  // ── Step 3: Download – send edited rows, receive Excel ────────────────────

  const handleDownload = async () => {
    if (!previewRows.length) return;
    setConvStatus(STATUS.DOWNLOADING);

    try {
      const response = await fetch(`${baseURL}/convert/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: previewRows }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";\n]+)"?/i);
      a.download = match ? match[1] : "MISA_Import.xlsx";
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setConvStatus(STATUS.SUCCESS);
    } catch (err) {
      console.error("[HomePage] Download failed:", err);
      setErrorMsg(err.message || "Đã xảy ra lỗi khi tải xuống.");
      setConvStatus(STATUS.PREVIEW); // go back to preview on error
    }
  };

  /** Reset everything */
  const handleReset = () => {
    setSelectedFile(null);
    setPreviewHeaders([]);
    setPreviewRows([]);
    setConvStatus(STATUS.IDLE);
    setErrorMsg("");
  };

  // ── Chatbot helpers ────────────────────────────────────────────────────────

  const sendChatMessage = () => {
    if (!chatInput.trim()) return;
    setMessages((prev) => [
      ...prev,
      { from: "user", text: chatInput.trim() },
      {
        from: "bot",
        text: "Cảm ơn bạn đã liên hệ! Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể. 😊",
      },
    ]);
    setChatInput("");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const isPreview =
    convStatus === STATUS.PREVIEW || convStatus === STATUS.DOWNLOADING;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />

      <main className="flex-1">
        {/* ── UPLOAD / CONVERT SECTION ── */}
        {!isPreview && convStatus !== STATUS.SUCCESS && (
          <section className="py-16 px-4 text-center">
            <div className="max-w-3xl mx-auto">
              <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-100 text-blue-600 text-xs font-medium px-3 py-1.5 rounded-full mb-8">
                <ChevronRight size={12} />
                MỚI: NHẬN DIỆN THÔNG TIN TỰ ĐỘNG BẰNG AI
              </div>
              <h1 className="text-5xl sm:text-6xl font-black text-gray-900 leading-tight mb-4">
                Chuẩn Hoá Dữ Liệu <span className="text-blue-600">Kế Toán</span>
              </h1>
              <p className="text-gray-500 text-base sm:text-lg max-w-xl mx-auto leading-relaxed mb-12">
                Tải lên file Excel bán hàng — hệ thống tự động chuyển đổi sang
                định dạng nhập khẩu MISA mà không cần tải lên bất kỳ mẫu nào.
              </p>

              <div className="max-w-xl mx-auto">
                {/* Drop zone */}
                {(convStatus === STATUS.IDLE ||
                  convStatus === STATUS.ERROR) && (
                  <>
                    <div
                      className={`relative border-2 border-dashed rounded-2xl p-10 cursor-pointer transition-all ${
                        dragActive
                          ? "border-blue-500 bg-blue-50 scale-[1.01]"
                          : selectedFile
                            ? "border-blue-400 bg-blue-50/40"
                            : "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"
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
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={handleFileInput}
                      />
                      <div className="flex flex-col items-center gap-4">
                        {selectedFile ? (
                          <>
                            <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center">
                              <FileSpreadsheet
                                size={26}
                                className="text-blue-600"
                              />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-gray-800 truncate max-w-xs">
                                {selectedFile.name}
                              </p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {(selectedFile.size / 1024).toFixed(1)} KB
                              </p>
                            </div>
                            <button
                              className="text-xs text-gray-400 hover:text-red-500 underline transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReset();
                              }}
                            >
                              Xoá và chọn file khác
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
                              <UploadCloud
                                size={28}
                                className="text-gray-400"
                              />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-700">
                                Kéo thả file Excel vào đây
                              </p>
                              <p className="text-xs text-gray-400 mt-1">
                                hoặc nhấn nút bên dưới để chọn file (.xlsx,
                                .xls)
                              </p>
                            </div>
                            <button
                              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                inputRef.current?.click();
                              }}
                            >
                              <FileSpreadsheet size={16} />
                              Chọn File
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {convStatus === STATUS.ERROR && errorMsg && (
                      <div className="mt-3 flex items-start gap-2 text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm">
                        <AlertCircle
                          size={16}
                          className="mt-0.5 flex-shrink-0"
                        />
                        <span>{errorMsg}</span>
                      </div>
                    )}

                    {selectedFile && (
                      <button
                        className="mt-4 w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
                        onClick={handleConvert}
                      >
                        <Pencil size={17} />
                        Phân tích &amp; Xem trước
                      </button>
                    )}
                  </>
                )}

                {/* Loading state */}
                {convStatus === STATUS.LOADING && (
                  <div className="border-2 border-blue-200 rounded-2xl p-10 bg-white flex flex-col items-center gap-4">
                    <Loader2 size={40} className="text-blue-500 animate-spin" />
                    <p className="text-sm font-medium text-gray-700">
                      Đang phân tích &amp; chuyển đổi file…
                    </p>
                    <p className="text-xs text-gray-400">
                      Quá trình này có thể mất vài giây.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-center gap-6 mt-6 text-xs text-gray-400">
                <span>Chuyển Đổi Excel → MISA</span>
                <span className="w-1 h-1 bg-gray-300 rounded-full" />
                <span>Nhận diện cột tự động</span>
                <span className="w-1 h-1 bg-gray-300 rounded-full" />
                <span>Bảo mật AES-256</span>
              </div>
            </div>
          </section>
        )}

        {/* ── SUCCESS STATE ── */}
        {convStatus === STATUS.SUCCESS && (
          <section className="py-16 px-4 text-center">
            <div className="max-w-md mx-auto border-2 border-green-200 rounded-2xl p-10 bg-white flex flex-col items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle size={32} className="text-green-600" />
              </div>
              <p className="text-base font-semibold text-gray-800">
                Tải xuống thành công!
              </p>
              <p className="text-xs text-gray-400">
                File MISA Import đã được lưu về máy của bạn.
              </p>
              <button
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium underline transition-colors"
                onClick={handleReset}
              >
                <Plus size={14} />
                Chuyển đổi file khác
              </button>
            </div>
          </section>
        )}

        {/* ── PREVIEW / EDIT TABLE ── */}
        {isPreview && (
          <section className="py-8 px-4">
            {/* Header bar */}
            <div className="max-w-full mx-auto mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Pencil size={18} className="text-blue-600" />
                  Xem trước &amp; chỉnh sửa dữ liệu
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {previewRows.length} dòng &nbsp;·&nbsp; Nhấp vào ô để chỉnh
                  sửa &nbsp;·&nbsp; Nhấn&nbsp;
                  <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-gray-600 font-mono text-[10px]">
                    Tab
                  </kbd>
                  &nbsp;để di chuyển giữa các ô
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReset}
                  className="text-sm px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  ← Tải file khác
                </button>
                <button
                  onClick={handleDownload}
                  disabled={convStatus === STATUS.DOWNLOADING}
                  className="flex items-center gap-2 text-sm px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors"
                >
                  {convStatus === STATUS.DOWNLOADING ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}
                  Tải xuống MISA Excel
                </button>
              </div>
            </div>

            {/* Error banner (download error) */}
            {errorMsg && convStatus === STATUS.PREVIEW && (
              <div className="max-w-full mx-auto mb-3 flex items-start gap-2 text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Editable table */}
            <div
              className="w-full overflow-auto rounded-xl border border-gray-200 shadow-sm bg-white"
              style={{ maxHeight: "65vh" }}
            >
              <table className="min-w-max text-xs border-collapse">
                {/* Sticky header */}
                <thead className="sticky top-0 z-10">
                  <tr>
                    {/* Row number column */}
                    <th className="sticky left-0 z-20 bg-gray-100 border-b border-r border-gray-200 px-3 py-2 text-gray-500 font-semibold text-center w-10">
                      #
                    </th>
                    {previewHeaders.map((h) => (
                      <th
                        key={h}
                        className="bg-gray-100 border-b border-r border-gray-200 px-3 py-2 text-left text-gray-700 font-semibold whitespace-nowrap min-w-[130px]"
                      >
                        {h}
                      </th>
                    ))}
                    {/* Delete column */}
                    <th className="bg-gray-100 border-b border-gray-200 px-3 py-2 text-center text-gray-500 font-semibold w-10">
                      Xoá
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-blue-50/30 group">
                      {/* Row number */}
                      <td className="sticky left-0 z-10 bg-white group-hover:bg-blue-50/30 border-b border-r border-gray-100 px-3 py-1 text-center text-gray-400 font-mono select-none">
                        {rIdx + 1}
                      </td>
                      {previewHeaders.map((h) => (
                        <td
                          key={h}
                          className="border-b border-r border-gray-100 p-0"
                        >
                          <input
                            type="text"
                            value={
                              row[h] !== undefined && row[h] !== null
                                ? row[h]
                                : ""
                            }
                            onChange={(e) =>
                              handleCellChange(rIdx, h, e.target.value)
                            }
                            className="w-full h-full px-3 py-1.5 text-xs text-gray-800 bg-transparent border-none outline-none focus:bg-blue-50 focus:ring-1 focus:ring-inset focus:ring-blue-400 rounded-none min-w-[130px]"
                          />
                        </td>
                      ))}
                      {/* Delete button */}
                      <td className="border-b border-gray-100 px-2 py-1 text-center">
                        <button
                          onClick={() => handleDeleteRow(rIdx)}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                          title="Xoá dòng này"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Bottom action bar */}
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleDownload}
                disabled={
                  convStatus === STATUS.DOWNLOADING || !previewRows.length
                }
                className="flex items-center gap-2 text-sm px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors shadow"
              >
                {convStatus === STATUS.DOWNLOADING ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Download size={16} />
                )}
                Tải xuống MISA Excel ({previewRows.length} dòng)
              </button>
            </div>
          </section>
        )}
      </main>

      <Footer />

      {/* ── Chatbot Widget ── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {chatOpen && (
          <div className="w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
            <div className="bg-blue-600 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                  <MessageCircle size={16} className="text-white" />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">
                    EzFormat AI
                  </p>
                  <p className="text-blue-200 text-xs">Luôn sẵn sàng hỗ trợ</p>
                </div>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                className="text-white/80 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 h-64 overflow-y-auto p-4 space-y-3 bg-gray-50">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
                      msg.from === "user"
                        ? "bg-blue-600 text-white rounded-br-sm"
                        : "bg-white text-gray-700 border border-gray-200 rounded-bl-sm"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-3 py-3 bg-white border-t border-gray-100 flex items-center gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChatMessage();
                }}
                placeholder="Nhập tin nhắn..."
                className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={sendChatMessage}
                className="w-9 h-9 bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center justify-center text-white flex-shrink-0 transition-colors"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="w-14 h-14 bg-blue-600 hover:bg-blue-700 rounded-full shadow-lg flex items-center justify-center text-white transition-all hover:scale-105 active:scale-95"
        >
          {chatOpen ? <X size={22} /> : <MessageCircle size={22} />}
        </button>
      </div>
    </div>
  );
};

export default HomePage;
