import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Menu, X } from "lucide-react";

// EzFormat Logo SVG inline
const Logo = () => (
  <Link to="/" className="flex items-center gap-2">
    <div className="relative w-8 h-8">
      <div className="absolute inset-0 bg-blue-600 rounded-sm transform rotate-3" />
      <div className="absolute inset-0 bg-green-500 rounded-sm transform -rotate-3 opacity-80" />
      <span className="absolute inset-0 flex items-center justify-center text-white font-black text-xs">
        EZ
      </span>
    </div>
    <span className="font-bold text-gray-900 text-lg">EzFormat</span>
  </Link>
);

const Navbar = () => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/");
  };

  return (
    <nav className="bg-white border-b border-gray-100 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Logo />

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            <Link
              to="/convert"
              className="text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
            >
              Chuyển đổi
            </Link>
            <Link
              to="/contact"
              className="text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
            >
              Liên hệ
            </Link>
            <Link
              to="/pricing"
              className="text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
            >
              Bảng Giá
            </Link>
          </div>

          {/* Auth buttons */}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                {isAdmin() && (
                  <Link
                    to="/admin"
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  >
                    Dashboard
                  </Link>
                )}
                <span className="text-sm text-gray-600">
                  Xin chào, {user.name}
                </span>
                <button
                  onClick={handleLogout}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Đăng xuất
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium px-4 py-2 transition-colors"
                >
                  Đăng nhập
                </Link>
                <Link
                  to="/register"
                  className="text-sm text-white font-medium bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors"
                >
                  Đăng ký
                </Link>
              </>
            )}
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden bg-white border-t border-gray-100 px-4 py-4 space-y-3">
          <Link
            to="/convert"
            className="block text-sm text-gray-600 font-medium py-2"
          >
            Chuyển đổi
          </Link>
          <Link
            to="/contact"
            className="block text-sm text-gray-600 font-medium py-2"
          >
            Liên hệ
          </Link>
          <Link
            to="/pricing"
            className="block text-sm text-gray-600 font-medium py-2"
          >
            Bảng Giá
          </Link>
          {user ? (
            <>
              {isAdmin() && (
                <Link
                  to="/admin"
                  className="block text-sm text-blue-600 font-medium py-2"
                >
                  Dashboard
                </Link>
              )}
              <button
                onClick={handleLogout}
                className="block text-sm text-gray-600 font-medium py-2 w-full text-left"
              >
                Đăng xuất
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="block text-sm text-gray-600 font-medium py-2"
              >
                Đăng nhập
              </Link>
              <Link
                to="/register"
                className="block text-sm text-white font-medium bg-blue-600 px-4 py-2 rounded-lg text-center"
              >
                Đăng ký
              </Link>
            </>
          )}
        </div>
      )}
    </nav>
  );
};

export default Navbar;
