import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { LogOut, Menu, X } from "lucide-react";
import ezFormatLogo from "../assets/ezformat-logo-64.webp";
import UserPlanBadge from "./UserPlanBadge";
import FeedbackModal from "./FeedbackModal";
import ChangePasswordModal from "./ChangePasswordModal";
import { studentAssistantEnabled } from "../hooks/useStudentAssistantApi";

const workspacesEnabled =
  String(
    import.meta.env.VITE_MASTER_DATA_WORKSPACES_ENABLED || "true",
  ).toLowerCase() !== "false";

const Logo = () => (
  <Link to="/" className="flex items-center gap-2.5 group">
    <img
      src={ezFormatLogo}
      alt="EzFormat logo"
      className="w-9 h-9 object-contain transition-transform group-hover:scale-105"
    />
    <span className="text-xl font-extrabold tracking-tight text-gray-950">
      EzFormat
    </span>
  </Link>
);

const navLinkClass = ({ isActive }) =>
  `text-base font-semibold transition-colors px-1.5 py-1 border-b-2 ${
    isActive
      ? "text-primary-600 border-primary-600"
      : "text-gray-600 border-transparent hover:text-gray-900 hover:border-gray-200"
  }`;

const Navbar = () => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const menuRef = useRef(null);

  const closeMobile = () => setMobileOpen(false);
  const closeUserMenu = () => setUserMenuOpen(false);

  // 1 lúc chỉ 1 dropdown: mở user menu thì đóng popover đăng xuất và ngược lại.
  const toggleUserMenu = () => {
    setLogoutConfirmOpen(false);
    setUserMenuOpen((open) => !open);
  };

  const requestLogout = () => {
    setUserMenuOpen(false);
    setLogoutConfirmOpen((open) => !open);
  };

  // Click ra ngoài cụm menu desktop -> đóng mọi dropdown đang mở.
  useEffect(() => {
    if (!userMenuOpen && !logoutConfirmOpen) return undefined;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setUserMenuOpen(false);
        setLogoutConfirmOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen, logoutConfirmOpen]);

  const handleLogout = () => {
    logout();
    setLogoutConfirmOpen(false);
    closeMobile();
    closeUserMenu();
    navigate("/");
  };

  const LogoutConfirmPopover = ({ mobile = false }) => (
    <div
      className={`z-[80] w-80 rounded-2xl border border-gray-100 bg-white p-4 text-left shadow-xl shadow-gray-200/70 ${
        mobile ? "mt-2" : "absolute right-0 top-full mt-3"
      }`}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
          <LogOut size={20} />
        </div>
        <div>
          <h2 className="text-sm font-bold text-gray-900">Xác nhận đăng xuất</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            Bạn có chắc muốn đăng xuất khỏi tài khoản hiện tại không?
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setLogoutConfirmOpen(false)}
          className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
        >
          Hủy
        </button>
        <button
          type="button"
          onClick={handleLogout}
          className="flex-1 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Đăng xuất
        </button>
      </div>
    </div>
  );

  return (
    <nav className="bg-white/90 backdrop-blur-md border-b border-gray-100/80 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Logo />

          <div className="hidden md:flex items-center gap-8">
            <NavLink to="/" className={navLinkClass}>
              Trang chủ
            </NavLink>
            <NavLink to="/convert" className={navLinkClass}>
              Chuyển đổi
            </NavLink>
            {studentAssistantEnabled && (
              <NavLink to="/student" className={navLinkClass}>
                Sinh viên
              </NavLink>
            )}
            <NavLink to="/pricing" className={navLinkClass}>
              Bảng giá
            </NavLink>
            <NavLink to="/contact" className={navLinkClass}>
              Liên hệ
            </NavLink>
          </div>

          <div className="hidden md:flex items-center gap-3" ref={menuRef}>
            {user ? (
              <>
                {isAdmin() && (
                  <NavLink to="/admin" className={navLinkClass}>
                    Dashboard
                  </NavLink>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={toggleUserMenu}
                    className="max-w-[150px] truncate rounded-xl px-3 py-2 text-base font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                    aria-expanded={userMenuOpen}
                  >
                    {user.name}
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-3 w-72 rounded-2xl border border-gray-100 bg-white p-3 shadow-xl shadow-gray-200/70">
                      <p className="mb-2 truncate px-1 text-sm font-semibold text-gray-800">
                        {user.name}
                      </p>
                      <UserPlanBadge user={user} />
                      {workspacesEnabled && (
                        <Link
                          to="/workspaces"
                          onClick={closeUserMenu}
                          className="mt-1 block rounded-xl px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Hồ sơ doanh nghiệp
                        </Link>
                      )}
                      <Link
                        to="/pricing"
                        onClick={closeUserMenu}
                        className="mt-3 block rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                      >
                        Xem / nâng cấp gói
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          closeUserMenu();
                          setChangePwOpen(true);
                        }}
                        className="mt-1 block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        Đổi mật khẩu
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeUserMenu();
                          setFeedbackOpen(true);
                        }}
                        className="mt-1 block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        Góp ý
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button
                    type="button"
                    onClick={requestLogout}
                    className="btn-secondary py-2 text-base font-semibold"
                  >
                    Đăng xuất
                  </button>
                  {logoutConfirmOpen && <LogoutConfirmPopover />}
                </div>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="px-3 py-2 text-base font-semibold text-gray-600 transition-colors hover:text-gray-900"
                >
                  Đăng nhập
                </Link>
                <Link to="/register" className="btn-primary py-2">
                  Đăng ký
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-expanded={mobileOpen}
            aria-label="Menu"
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-gray-100 bg-white px-4 py-4 space-y-1 animate-fade-in">
          <NavLink to="/" className={navLinkClass} onClick={closeMobile}>
            Trang chủ
          </NavLink>
          <NavLink to="/convert" className={navLinkClass} onClick={closeMobile}>
            Chuyển đổi
          </NavLink>
          {studentAssistantEnabled && (
            <NavLink to="/student" className={navLinkClass} onClick={closeMobile}>
              Sinh viên
            </NavLink>
          )}
          <NavLink to="/pricing" className={navLinkClass} onClick={closeMobile}>
            Bảng giá
          </NavLink>
          <NavLink to="/contact" className={navLinkClass} onClick={closeMobile}>
            Liên hệ
          </NavLink>
          {user ? (
            <>
              {isAdmin() && (
                <NavLink to="/admin" className={navLinkClass} onClick={closeMobile}>
                  Dashboard
                </NavLink>
              )}
              <div className="py-2">
                <button
                  type="button"
                  onClick={toggleUserMenu}
                  className="mb-2 w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  aria-expanded={userMenuOpen}
                >
                  {user.name}
                </button>
                {userMenuOpen && (
                  <div className="px-1">
                    <UserPlanBadge user={user} />
                    {workspacesEnabled && (
                      <Link
                        to="/workspaces"
                        className="mt-2 block rounded-xl px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          closeUserMenu();
                          closeMobile();
                        }}
                      >
                        Hồ sơ doanh nghiệp
                      </Link>
                    )}
                    <Link
                      to="/pricing"
                      className="mt-2 block rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                      onClick={() => {
                        closeUserMenu();
                        closeMobile();
                      }}
                    >
                      Xem / nâng cấp gói
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        closeUserMenu();
                        closeMobile();
                        setChangePwOpen(true);
                      }}
                      className="mt-1 block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Đổi mật khẩu
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeUserMenu();
                        closeMobile();
                        setFeedbackOpen(true);
                      }}
                      className="mt-1 block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Góp ý
                    </button>
                  </div>
                )}
              </div>
              <div>
                <button
                  type="button"
                  onClick={requestLogout}
                  className="block w-full py-2 text-left text-base font-semibold text-gray-600"
                >
                  Đăng xuất
                </button>
                {logoutConfirmOpen && <LogoutConfirmPopover mobile />}
              </div>
            </>
          ) : (
            <div className="pt-2 flex flex-col gap-2">
              <Link
                to="/login"
                className="btn-secondary text-center"
                onClick={closeMobile}
              >
                Đăng nhập
              </Link>
              <Link
                to="/register"
                className="btn-primary text-center"
                onClick={closeMobile}
              >
                Đăng ký
              </Link>
            </div>
          )}
        </div>
      )}

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />
    </nav>
  );
};

export default Navbar;
