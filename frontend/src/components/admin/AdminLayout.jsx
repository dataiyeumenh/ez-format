import { useState, useRef, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  FileText,
  Package,
  BarChart2,
  MessageSquare,
  TicketPercent,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import ezFormatMainLogo from "../../assets/ezformat-logo-128.webp";

const navItems = [
  { icon: LayoutDashboard, label: "Tổng quan", path: "/admin" },
  { icon: Users, label: "Người dùng", path: "/admin/users" },
  { icon: FileText, label: "Chuyển đổi file", path: "/admin/files" },
  { icon: Package, label: "Gói dịch vụ", path: "/admin/plans" },
  { icon: TicketPercent, label: "Chương trình đặc biệt", path: "/admin/coupons" },
  { icon: BarChart2, label: "Phân tích doanh thu", path: "/admin/revenue" },
  { icon: MessageSquare, label: "Góp ý", path: "/admin/logs" },
];

const AdminLayout = ({ children, title: _title }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setAvatarOpen(false);
        setLogoutConfirmOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = () => {
    logout();
    setLogoutConfirmOpen(false);
    navigate("/login");
  };

  const isActive = (path) => {
    if (path === "/admin")
      return location.pathname === "/admin" || location.pathname === "/admin/dashboard";
    return location.pathname.startsWith(path);
  };
  const currentSection =
    navItems.find((item) => isActive(item.path))?.label || "Quản trị";

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="w-56 bg-gray-900 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
          <img
            src={ezFormatMainLogo}
            alt="EzFormat logo"
            className="h-7 w-7 object-contain"
          />
          <span className="font-bold text-white text-base">EzFormat</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.label}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive(item.path)
                  ? "bg-blue-600 text-white font-medium"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              <item.icon size={16} />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 h-14 flex items-center justify-between px-6">
          <h1 className="text-sm font-bold text-gray-800">{currentSection}</h1>

          <div className="flex items-center gap-4">
            {/* Avatar Dropdown */}
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => {
                  setLogoutConfirmOpen(false);
                  setAvatarOpen(!avatarOpen);
                }}
                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                aria-expanded={avatarOpen}
              >
                <div className="text-right">
                  <p className="text-sm font-medium text-gray-900 leading-tight">
                    {user?.name || "EzFormat"}
                  </p>
                  <p className="text-xs text-gray-500">Admin</p>
                </div>
                <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-sm">
                  {user?.name?.[0]?.toUpperCase() || "A"}
                </div>
                <ChevronDown
                  size={14}
                  className={`text-gray-400 transition-transform ${avatarOpen ? "rotate-180" : ""}`}
                />
              </button>

              {/* Dropdown menu */}
              {avatarOpen && (
                <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50">
                  <div className="px-4 py-2.5 border-b border-gray-100 mb-1">
                    <p className="text-sm font-semibold text-gray-900">{user?.name}</p>
                    <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                  </div>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setAvatarOpen(false);
                        setLogoutConfirmOpen(true);
                      }}
                      className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut size={16} />
                      Đăng xuất
                    </button>
                  </div>
                </div>
              )}
              {logoutConfirmOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-gray-100 bg-white p-4 shadow-xl">
                  <h2 className="text-sm font-bold text-gray-900">
                    Xác nhận đăng xuất
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    Bạn có chắc muốn đăng xuất khỏi trang quản trị không?
                  </p>
                  <div className="mt-4 flex gap-2">
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
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

export default AdminLayout;
