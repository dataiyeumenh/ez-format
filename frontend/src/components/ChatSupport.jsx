import { useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";

const DEFAULT_MESSAGES = [
  { from: "bot", text: "Xin chào! Tôi có thể giúp gì cho bạn?" },
  {
    from: "bot",
    text: "Hỏi về chuyển đổi Excel → MISA, bảng giá hoặc hỗ trợ kỹ thuật.",
  },
];

const ChatSupport = ({ initialMessages = DEFAULT_MESSAGES }) => {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState(initialMessages);

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
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3 sm:bottom-6 sm:right-6">
      {chatOpen && (
        <div className="animate-fade-in max-h-[70vh] w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-2xl sm:w-80">
          <div className="flex items-center justify-between bg-primary-600 px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">EzFormat Support</p>
              <p className="text-xs text-primary-100">Phản hồi trong vài phút</p>
            </div>
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="rounded-lg p-1 hover:bg-white/10"
              aria-label="Đóng chat"
            >
              <X size={16} />
            </button>
          </div>
          <div className="table-scroll h-52 space-y-3 overflow-y-auto bg-gray-50/80 p-4 sm:h-64">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    msg.from === "user"
                      ? "rounded-br-md bg-primary-600 text-white"
                      : "rounded-bl-md border border-gray-100 bg-white text-gray-700 shadow-sm"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-t bg-white px-3 py-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
              placeholder="Nhập tin nhắn..."
              className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/25"
            />
            <button
              type="button"
              onClick={sendChatMessage}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-white hover:bg-primary-700"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setChatOpen(!chatOpen)}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-white shadow-lg shadow-primary-500/30 transition-transform hover:scale-105 hover:bg-primary-700 active:scale-95 sm:h-14 sm:w-14"
        aria-label={chatOpen ? "Đóng chat" : "Mở chat"}
      >
        {chatOpen ? <X size={20} /> : <MessageCircle size={20} />}
      </button>
    </div>
  );
};

export default ChatSupport;
