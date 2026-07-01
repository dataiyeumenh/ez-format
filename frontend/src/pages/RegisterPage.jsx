import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, User, AlertCircle, CheckCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import Alert from "../components/ui/Alert";
import GoogleSignInButton from "../components/GoogleSignInButton";
import { getApiErrorMessage } from "../utils/apiError";
import { getPostLoginPath } from "../utils/authRedirect";
import ezFormatMainLogo from "../assets/ezformat-main-logo.png";

const RegisterPage = () => {
  const navigate = useNavigate();
  const { register, loginWithGoogle } = useAuth();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorPopup, setErrorPopup] = useState("");
  const [successPopup, setSuccessPopup] = useState("");

  useEffect(() => {
    if (!successPopup) return undefined;
    const timer = window.setTimeout(() => {
      setSuccessPopup("");
      navigate("/login");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [navigate, successPopup]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setError("");
    setErrorPopup("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      const message = "Mật khẩu xác nhận không khớp";
      setError(message);
      setErrorPopup(message);
      return;
    }
    setLoading(true);
    setError("");
    try {
      await register(formData.name, formData.email, formData.password);
      setSuccessPopup(
        "Tạo tài khoản thành công. Vui lòng đăng nhập để bắt đầu sử dụng EzFormat.",
      );
    } catch (err) {
      const message = getApiErrorMessage(err, "Đăng ký thất bại");
      setError(message);
      setErrorPopup(message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = async (credential) => {
    setLoading(true);
    setError("");
    try {
      const user = await loginWithGoogle(credential);
      navigate(getPostLoginPath(user));
    } catch (err) {
      const message = getApiErrorMessage(err, "Đăng nhập Google thất bại");
      setError(message);
      setErrorPopup(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {/* Logo */}
          <div className="flex flex-col items-center mb-6">
            <img
              src={ezFormatMainLogo}
              alt="EzFormat logo"
              className="mb-3 h-16 w-16 object-contain"
            />
            <h2 className="text-lg font-bold text-gray-900">Tạo tài khoản mới</h2>
            <p className="text-sm text-gray-500 text-center mt-1">
              Tham gia EzFormat và chuẩn hoá dữ liệu kế toán của bạn
            </p>
          </div>

          {/* Error */}
          {error && (
            <Alert variant="error" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Họ và tên
              </label>
              <div className="relative">
                <User
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="Nguyễn Văn A"
                  required
                  className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            {/* Email */}
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
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="name@company.com"
                  required
                  className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Mật khẩu
              </label>
              <div className="relative">
                <Lock
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="Tối thiểu 6 ký tự"
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

            {/* Confirm Password */}
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
                  type={showConfirmPassword ? "text" : "password"}
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  placeholder="Nhập lại mật khẩu"
                  required
                  className="w-full pl-9 pr-10 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 rounded-lg transition-colors text-sm"
            >
              {loading ? "Đang tạo tài khoản..." : "Tạo tài khoản"}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 uppercase">HOẶC TIẾP TỤC VỚI</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {/* Google */}
          <GoogleSignInButton
            onCredential={handleGoogleCredential}
            disabled={loading}
          />

          {/* Login link */}
          <p className="text-center text-sm text-gray-500 mt-5">
            Đã có tài khoản?{" "}
            <Link to="/login" className="text-blue-600 hover:text-blue-700 font-medium">
              Đăng nhập
            </Link>
          </p>
        </div>
      </main>
      <Footer />
      {errorPopup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-600">
              <AlertCircle size={28} />
            </div>
            <h2 className="mb-2 text-lg font-bold text-gray-900">
              Đăng ký thất bại
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-gray-500">
              {errorPopup}
            </p>
            <button
              type="button"
              onClick={() => setErrorPopup("")}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Thử lại
            </button>
          </div>
        </div>
      )}
      {successPopup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <CheckCircle size={28} />
            </div>
            <h2 className="mb-2 text-lg font-bold text-gray-900">
              Đăng ký thành công
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-gray-500">
              {successPopup}
            </p>
            <button
              type="button"
              onClick={() => navigate("/login")}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Đi tới đăng nhập
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RegisterPage;
