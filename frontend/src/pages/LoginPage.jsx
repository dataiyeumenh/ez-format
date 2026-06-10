import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import Alert from "../components/ui/Alert";
import GoogleSignInButton from "../components/GoogleSignInButton";
import { getApiErrorMessage } from "../utils/apiError";
import ezFormatMainLogo from "../assets/ezformat-main-logo.png";

const LoginPage = () => {
  const navigate = useNavigate();
  const { login, loginWithGoogle } = useAuth();
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const user = await login(formData.email, formData.password);
      if (user.role === "admin") {
        navigate("/admin");
      } else {
        navigate("/");
      }
    } catch (err) {
      setError(getApiErrorMessage(err, "Đăng nhập thất bại"));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = async (credential) => {
    setLoading(true);
    setError("");
    try {
      const user = await loginWithGoogle(credential);
      navigate(user.role === "admin" ? "/admin" : "/");
    } catch (err) {
      setError(getApiErrorMessage(err, "Đăng nhập Google thất bại"));
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
              className="w-16 h-16 object-contain mb-3"
            />
            <p className="text-base font-medium leading-relaxed text-gray-700 text-center">
              Chào mừng trở lại, hãy đăng nhập vào <br />
              tài khoản của bạn
            </p>
          </div>

          {/* Error */}
          {error && (
            <Alert variant="error" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
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
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">
                  Mật khẩu
                </label>
                <Link
                  to="/contact"
                  className="text-xs text-primary-600 hover:text-primary-700"
                >
                  Quên mật khẩu?
                </Link>
              </div>
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

            {/* Remember me */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="rememberMe"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600"
              />
              <label htmlFor="rememberMe" className="text-sm text-gray-600">
                Lưu tài khoản trong 30 ngày
              </label>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 rounded-lg transition-colors text-sm"
            >
              {loading ? "Đang đăng nhập..." : "Đăng nhập vào tài khoản"}
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

          {/* Register link */}
          <p className="text-center text-sm text-gray-500 mt-5">
            Chưa có tài khoản?{" "}
            <Link
              to="/register"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              Tạo tài khoản
            </Link>
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default LoginPage;
