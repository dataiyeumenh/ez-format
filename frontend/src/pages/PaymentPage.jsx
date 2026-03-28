import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const AppleLogo = () => (
  <svg viewBox="0 0 814 1000" className="w-5 h-5" fill="currentColor">
    <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105.3-57.9-155.5-127.4C46 790.7 0 663 0 541.8c0-207.5 135.4-317.3 269-317.3 71 0 130.5 46.4 174.9 46.4 42.7 0 109.2-49 192.5-49 30.4.1 107.9 4 167.1 56zM527.2 23.6C544.3-5 558.9-49.8 558.9-80c0-3.2-.6-6.4-1.2-9.7-40.8 3.2-89.5 27.8-118.8 56.2-23.1 22.5-42 64.5-42 99.5 0 3.8.6 7.7 1.3 11.5 2.6.6 6.4 1.3 10.3 1.3 36.8-.1 82.1-24.6 119.7-55.2z" />
  </svg>
);

const GoogleLogo = () => (
  <svg viewBox="0 0 488 512" className="w-5 h-5">
    <path
      fill="#4285F4"
      d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C315.2 97.9 283.8 86 248 86c-86.3 0-156.2 72.5-156.2 170s69.9 170 156.2 170c100.5 0 138.4-72.1 143.1-109.1H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z"
    />
  </svg>
);

const paymentMethods = [
  { id: "apple", label: "Pay", icon: <AppleLogo /> },
  { id: "google", label: "Pay", icon: <GoogleLogo /> },
  {
    id: "card",
    label: "Thanh toán qua thẻ ngân hàng",
    desc: "Để thanh toán, vui lòng nhập thông tin thẻ VISA, MasterCard hoặc Maestro của bạn.",
    icon: "💳",
  },
  {
    id: "banking",
    label: "Thanh toán qua Internet Banking",
    desc: "Bạn muốn thanh toán ngay qua ngân hàng trực tuyến? Chỉ cần chọn ngân hàng và tiến hành giao dịch.",
    icon: "🏦",
    highlight: true,
  },
];

const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState("banking");

  const planName = location.state?.planName;
  const planPrice = location.state?.planPrice;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 py-10 px-4">
        <h1 className="text-3xl font-black text-gray-900 text-center mb-8">
          Thanh Toán
        </h1>

        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-2">
            {/* Left – payment methods */}
            <div className="p-6 border-r border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">
                Chọn 1 phương thức thanh toán
              </h2>
              <div className="space-y-3">
                {paymentMethods.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSelected(m.id)}
                    className={`w-full text-left rounded-xl border transition-all ${
                      selected === m.id
                        ? m.highlight
                          ? "border-blue-500 bg-blue-600 text-white"
                          : "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}
                  >
                    {m.desc ? (
                      <div className="p-4">
                        <div className="flex items-center gap-2 mb-1">
                          {m.id === "card" && (
                            <div className="flex gap-1">
                              <span className="text-xs font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                                VISA
                              </span>
                              <span className="text-xs font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                                MC
                              </span>
                            </div>
                          )}
                          {m.id === "banking" && (
                            <span className="text-lg">🏦</span>
                          )}
                          <span
                            className={`text-sm font-semibold ${selected === m.id && m.highlight ? "text-white" : "text-gray-800"}`}
                          >
                            {m.label}
                          </span>
                        </div>
                        <p
                          className={`text-xs leading-relaxed ${selected === m.id && m.highlight ? "text-blue-100" : "text-gray-500"}`}
                        >
                          {m.desc}
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-2 py-3.5 px-4">
                        <span className="flex-shrink-0 text-gray-800">
                          {m.icon}
                        </span>
                        <span className="text-sm font-semibold text-gray-700">
                          {m.label}
                        </span>
                      </div>
                    )}
                  </button>
                ))}
              </div>

              <button
                onClick={() => navigate("/")}
                className="w-full mt-6 bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 rounded-xl transition-colors text-sm"
              >
                Thanh toán
              </button>
            </div>

            {/* Right – order summary */}
            <div className="p-6 bg-gray-50/50 flex flex-col">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">
                Đơn hàng của bạn
              </h2>

              <div className="bg-white rounded-xl border border-gray-100 p-4 flex-1">
                <div className="space-y-3">
                  {[
                    { label: planName, value: planPrice },
                    { label: "Số lượng", value: "1" },
                    {
                      label: "Áp dụng ưu đãi",
                      value: "-0 VND",
                      valueColor: "text-green-600",
                    },
                    { label: "Thuế", value: "0 VND" },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="flex justify-between text-sm"
                    >
                      <span className="text-gray-500">{row.label}</span>
                      <span
                        className={`font-medium ${row.valueColor || "text-gray-700"}`}
                      >
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="border-t border-dashed border-gray-200 mt-4 pt-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">
                      Tổng giá tiền
                    </p>
                    <p className="text-xl font-black text-gray-900">
                      {planPrice}
                    </p>
                  </div>
                  <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center">
                    <FileText size={22} className="text-blue-600" />
                  </div>
                </div>
              </div>

              <p className="text-xs text-gray-400 text-center mt-4">
                Bằng cách tiếp tục, bạn đồng ý với{" "}
                <span className="text-blue-600 cursor-pointer hover:underline">
                  Điều khoản dịch vụ
                </span>
              </p>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default PaymentPage;
