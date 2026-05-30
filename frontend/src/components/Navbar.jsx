import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Menu, X } from "lucide-react";

const Logo = () => (
  <Link to="/" className="flex items-center gap-2.5 group">
    <div className="relative w-9 h-9 transition-transform group-hover:scale-105">
      <div className="absolute inset-0 bg-gradient-to-br from-red-600 to-red-500 rounded-lg rotate-6 shadow-sm" />
      <div className="absolute inset-0 bg-gradient-to-br from-primary-600 to-cyan-500 rounded-lg -rotate-6 opacity-90" />
      <span className="absolute inset-0 flex items-center justify-center text-white font-black text-[10px] tracking-tight">
        EZ
      </span>
    </div>
    <span className="font-bold text-gray-900 text-lg tracking-tight">EzFormat</span>
  </Link>
);

const navLinkClass = ({ isActive }) =>
  `text-sm font-medium transition-colors px-1 py-0.5 border-b-2 ${
    isActive
      ? "text-primary-600 border-primary-600"
      : "text-gray-600 border-transparent hover:text-gray-900 hover:border-gray-200"
  }`;

const Navbar = () => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMobile = () => setMobileOpen(false);

  const handleLogout = () => {
    logout();
    closeMobile();
    navigate("/");
  };

  return (
    <nav className="bg-white/90 backdrop-blur-md border-b border-gray-100/80 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Logo />

          <div className="hidden md:flex items-center gap-8">
            <NavLink to="/convert" className={navLinkClass}>
              Chuyển đổi
            </NavLink>
            <NavLink to="/pricing" className={navLinkClass}>
              Bảng giá
            </NavLink>
            <NavLink to="/contact" className={navLinkClass}>
              Liên hệ
            </NavLink>
          </div>

          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                {isAdmin() && (
                  <NavLink to="/admin" className={navLinkClass}>
                    Dashboard
                  </NavLink>
                )}
                <span className="text-sm text-gray-500 max-w-[120px] truncate">
                  {user.name}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="btn-secondary py-2"
                >
                  Đăng xuất
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2 transition-colors"
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
          <NavLink to="/convert" className={navLinkClass} onClick={closeMobile}>
            Chuyển đổi
          </NavLink>
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
              <button
                type="button"
                onClick={handleLogout}
                className="block w-full text-left text-sm font-medium text-gray-600 py-2"
              >
                Đăng xuất
              </button>
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
    </nav>
  );
};

export default Navbar;
