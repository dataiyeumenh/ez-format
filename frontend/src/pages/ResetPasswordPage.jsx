import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Lock, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import api from "../services/api";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import Alert from "../components/ui/Alert";
import { getApiErrorMessage } from "../utils/apiError";
import ezFormatMainLogo from "../assets/ezformat-logo-128.webp";

const ResetPasswordPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [tokenState, setTokenState] = useState("checking"); // checking | valid | invalid
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!token) {
        if (active) setTokenState("invalid");
        return;
      }
      try {
        const { data } = await api.get("/auth/reset-password/validate", {
          params: { token },
        });
        if (active) setTokenState(data.valid ? "valid" : "invalid");
      } catch {
        if (active) setTokenState("invalid");
      }
    };
    check();
    return () => {
      active = false;
    };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 6) {
      setError("Mật khẩu tối thiểu 6 ký tự.");
      return;
    }
    if (password !== confirm) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.post("/auth/reset-password", { token, password });
      setDone(true);
      setTimeout(() => navigate("/login"), 2200);
    } catch (err) {
      setError(getApiErrorMessage(err, "Đặt lại mật khẩu thất bại. Vui lòng thử lại."));
    } finally {
      setLoading(false);
    }
  };

  const Card = ({ children }) => (
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
            <h1 className="text-lg font-bold text-gray-900">Đặt lại mật khẩu</h1>
          </div>
          {children}
        </div>
      </main>
      <Footer />
    </div>
  );

  if (tokenState === "checking") {
    return (
      <Card>
        <div className="flex items-center justify-center gap-3 py-6 text-gray-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Đang kiểm tra liên kết...</span>
        </div>
      </Card>
    );
  }

  if (tokenState === "invalid") {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <AlertCircle size={28} />
          </div>
          <p className="text-sm leading-relaxed text-gray-600">
            Liên kết đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết
            mới.
          </p>
          <Link
            to="/forgot-password"
            className="mt-6 inline-block rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Gửi lại liên kết
          </Link>
        </div>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
            <CheckCircle2 size={28} />
          </div>
          <p className="text-sm leading-relaxed text-gray-600">
            Đặt lại mật khẩu thành công! Đang chuyển tới trang đăng nhập...
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Mật khẩu mới
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              placeholder="••••••••"
              required
              className="w-full pl-9 pr-10 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Xác nhận mật khẩu
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError("");
              }}
              placeholder="••••••••"
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
          {loading ? "Đang lưu..." : "Đặt lại mật khẩu"}
        </button>
      </form>
    </Card>
  );
};

export default ResetPasswordPage;
