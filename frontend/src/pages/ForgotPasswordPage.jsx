import { useState } from "react";
import { Link } from "react-router-dom";
import { Mail, ArrowLeft, MailCheck } from "lucide-react";
import api from "../services/api";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import Alert from "../components/ui/Alert";
import { getApiErrorMessage } from "../utils/apiError";
import ezFormatMainLogo from "../assets/ezformat-main-logo.png";

const ForgotPasswordPage = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(getApiErrorMessage(err, "Không gửi được yêu cầu. Vui lòng thử lại."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <div className="flex flex-col items-center mb-6">
            <img
              src={ezFormatMainLogo}
              alt="EzFormat logo"
              className="w-16 h-16 object-contain mb-3"
            />
            <h1 className="text-lg font-bold text-gray-900">Quên mật khẩu</h1>
            <p className="mt-1 text-sm text-gray-500 text-center">
              Nhập email tài khoản, chúng tôi sẽ gửi liên kết đặt lại mật khẩu.
            </p>
          </div>

          {sent ? (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <MailCheck size={28} />
              </div>
              <p className="text-sm leading-relaxed text-gray-600">
                Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại
                mật khẩu. Vui lòng kiểm tra hộp thư (kể cả mục Spam).
              </p>
              <Link
                to="/login"
                className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                <ArrowLeft size={16} /> Về trang đăng nhập
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <Alert variant="error" className="mb-4">
                  {error}
                </Alert>
              )}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Địa chỉ Email
                  </label>
                  <div className="relative">
                    <Mail
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setError("");
                      }}
                      placeholder="name@company.com"
                      required
                      className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 rounded-lg transition-colors text-sm"
                >
                  {loading ? "Đang gửi..." : "Gửi liên kết đặt lại"}
                </button>
              </form>
              <Link
                to="/login"
                className="mt-5 flex items-center justify-center gap-2 text-sm text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft size={16} /> Về trang đăng nhập
              </Link>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default ForgotPasswordPage;
