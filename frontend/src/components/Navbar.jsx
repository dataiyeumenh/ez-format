import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Menu, X } from "lucide-react";
import ezFormatLogo from "../assets/ezformat-logo.jpg";

const Logo = () => (
  <Link to="/" className="flex items-center gap-2.5 group">
    <img
      src={ezFormatLogo}
      alt="EzFormat logo"
      className="w-9 h-9 object-contain transition-transform group-hover:scale-105"
    />
    <span className="text-xl font-extrabold tracking-tight text-gray-950">EzFormat</span>
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
                <span className="max-w-[120px] truncate text-base font-medium text-gray-600">
                  {user.name}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="btn-secondary py-2 text-base font-semibold"
                >
                  Đăng xuất
                </button>
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
                className="block w-full py-2 text-left text-base font-semibold text-gray-600"
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
