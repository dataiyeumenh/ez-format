import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Plus,
  FileSpreadsheet,
  ChevronRight,
  MessageCircle,
  X,
  Send,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const HomePage = () => {
  const [dragActive, setDragActive] = useState(false);
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
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />

      {/* Hero */}
      <main className="flex-1">
        <section className="py-16 px-4 text-center">
          <div className="max-w-3xl mx-auto">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-100 text-blue-600 text-xs font-medium px-3 py-1.5 rounded-full mb-8">
              <ChevronRight size={12} />
              MỚI: NHẬN DIỆN THÔNG TIN TỰ ĐỘNG BẰNG AI
            </div>

            {/* Heading */}
            <h1 className="text-5xl sm:text-6xl font-black text-gray-900 leading-tight mb-4">
              Chuẩn Hoá Dữ Liệu <span className="text-blue-600">Kế Toán</span>
            </h1>
            <p className="text-gray-500 text-base sm:text-lg max-w-xl mx-auto leading-relaxed mb-12">
              Tối ưu hoá quy trình kế toán và chuyển đổi các bảng tính phức tạp
              thành định dạng Excel tiêu chuẩn, phục vụ kiểm toán tức thời. Đơn
              giản hoá quy trình xử lý dữ liệu tài chính cho doanh nghiệp bạn.
            </p>

            {/* Upload Box */}
            <div
              className={`relative border-2 border-dashed rounded-2xl p-16 max-w-xl mx-auto cursor-pointer transition-all ${
                dragActive
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
              />

              <div className="flex flex-col items-center gap-4">
                <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
                  <Plus size={28} className="text-gray-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700">
                    Tải lên hoặc kéo thả file biểu mẫu vào đây
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Hỗ trợ định dạng Excel
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
              </div>
            </div>

            {/* Sub badges */}
            <div className="flex items-center justify-center gap-6 mt-6 text-xs text-gray-400">
              <span>Chuyển Đổi Excel</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full" />
              <span>Tích hợp OCR</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full" />
              <span>Bảo mật AES-256</span>
            </div>
          </div>
        </section>
      </main>

      <Footer />

      {/* ── Chatbot Widget ── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {chatOpen && (
          <div className="w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
            {/* Chat header */}
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

            {/* Messages */}
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

            {/* Input */}
            <div className="px-3 py-3 bg-white border-t border-gray-100 flex items-center gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && chatInput.trim()) {
                    const userMsg = { from: "user", text: chatInput.trim() };
                    const botReply = {
                      from: "bot",
                      text: "Cảm ơn bạn đã liên hệ! Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể. 😊",
                    };
                    setMessages((prev) => [...prev, userMsg, botReply]);
                    setChatInput("");
                  }
                }}
                placeholder="Nhập tin nhắn..."
                className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={() => {
                  if (chatInput.trim()) {
                    const userMsg = { from: "user", text: chatInput.trim() };
                    const botReply = {
                      from: "bot",
                      text: "Cảm ơn bạn đã liên hệ! Đội ngũ hỗ trợ sẽ phản hồi sớm nhất có thể. 😊",
                    };
                    setMessages((prev) => [...prev, userMsg, botReply]);
                    setChatInput("");
                  }
                }}
                className="w-9 h-9 bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center justify-center text-white flex-shrink-0 transition-colors"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Toggle button */}
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
