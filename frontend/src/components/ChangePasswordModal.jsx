import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { KeyRound, X, CheckCircle2, Eye, EyeOff } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../utils/apiError";

const PasswordField = ({ label, value, onChange, show, onToggle }) => (
  <div>
    <label className="mb-1.5 block text-sm font-semibold text-gray-700">{label}</label>
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder="••••••••"
        required
        className="w-full pl-3 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        aria-label={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  </div>
);

const ChangePasswordModal = ({ open, onClose }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Đã có mật khẩu (local hoặc Google đã từng đặt) -> cần mật khẩu hiện tại.
  // Chưa có (Google lần đầu) -> chỉ cần đặt mật khẩu mới.
  const requireCurrent = user?.hasPassword ?? user?.authProvider !== "google";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | submitting | success
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
    setStatus("idle");
    setError("");
  };

  const handleClose = () => {
    if (status === "submitting") return;
    reset();
    onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (newPassword.length < 6) {
      setError("Mật khẩu mới tối thiểu 6 ký tự.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }
    setStatus("submitting");
    setError("");
    try {
      await api.put("/auth/change-password", {
        newPassword,
        ...(requireCurrent ? { currentPassword } : {}),
      });
      setStatus("success");
      // Đổi mật khẩu xong -> đăng xuất để đăng nhập lại bằng mật khẩu mới.
      setTimeout(() => {
        logout();
        navigate("/login");
      }, 1800);
    } catch (err) {
      setStatus("idle");
      setError(getApiErrorMessage(err, "Đổi mật khẩu thất bại. Vui lòng thử lại."));
    }
  };

  const title = requireCurrent ? "Đổi mật khẩu" : "Đặt mật khẩu";
  const subtitle = requireCurrent
    ? "Nhập mật khẩu hiện tại và mật khẩu mới."
    : "Đặt mật khẩu để có thể đăng nhập bằng email khi cần.";

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-900/50 p-4 animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-6 shadow-2xl shadow-gray-300/60"
        onClick={(event) => event.stopPropagation()}
      >
        {status === "success" ? (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
              <CheckCircle2 size={30} />
            </div>
            <h2 className="mt-4 text-lg font-bold text-gray-900">Thành công</h2>
            <p className="mt-1 text-sm text-gray-500">
              Mật khẩu đã được cập nhật. Đang đăng xuất để bạn đăng nhập lại...
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <KeyRound size={20} />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">{title}</h2>
                  <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="Đóng"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {requireCurrent && (
                <PasswordField
                  label="Mật khẩu hiện tại"
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setError("");
                  }}
                  show={showCurrent}
                  onToggle={() => setShowCurrent((s) => !s)}
                />
              )}
              <PasswordField
                label="Mật khẩu mới"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setError("");
                }}
                show={showNew}
                onToggle={() => setShowNew((s) => !s)}
              />
              <PasswordField
                label="Xác nhận mật khẩu mới"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError("");
                }}
                show={showConfirm}
                onToggle={() => setShowConfirm((s) => !s)}
              />

              {error && (
                <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5 text-sm text-red-600">
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={status === "submitting"}
                  className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {status === "submitting" ? "Đang lưu..." : title}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default ChangePasswordModal;
