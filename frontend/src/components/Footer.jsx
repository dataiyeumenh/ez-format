import { Link } from "react-router-dom";
import { Share2, Settings } from "lucide-react";

const Footer = () => {
  return (
    <footer className="bg-gray-900 text-gray-300">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="relative w-8 h-8">
                <div className="absolute inset-0 bg-blue-500 rounded-sm transform rotate-3" />
                <div className="absolute inset-0 bg-green-400 rounded-sm transform -rotate-3 opacity-80" />
                <span className="absolute inset-0 flex items-center justify-center text-white font-black text-xs">
                  EZ
                </span>
              </div>
              <span className="font-bold text-white text-lg">EzFormat</span>
            </div>
            <p className="text-sm text-gray-400 leading-relaxed">
              Giải pháp tự động giúp làm sạch và chuẩn hoá dữ liệu kế toán nhanh
              chóng
            </p>
            <div className="flex items-center gap-3">
              <button className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center hover:bg-gray-700 transition-colors">
                <Share2 size={14} />
              </button>
              <button className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center hover:bg-gray-700 transition-colors">
                <Settings size={14} />
              </button>
            </div>
          </div>

          {/* Tài Nguyên */}
          <div className="space-y-3">
            <h4 className="font-semibold text-white text-sm uppercase tracking-wider">
              Tài Nguyên
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Tài liệu
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Hướng dẫn
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Trung tâm hỗ trợ
                </Link>
              </li>
            </ul>
          </div>

          {/* Công Ty */}
          <div className="space-y-3">
            <h4 className="font-semibold text-white text-sm uppercase tracking-wider">
              Công Ty
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Về chúng tôi
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Blog
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Tuyển dụng
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Bảo mật
                </Link>
              </li>
            </ul>
          </div>

          {/* Chính Sách & Pháp Lý */}
          <div className="space-y-3">
            <h4 className="font-semibold text-white text-sm uppercase tracking-wider">
              Chính Sách & Pháp Lý
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Quyền riêng tư
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Điều khoản dịch vụ
                </Link>
              </li>
              <li>
                <Link
                  to="#"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Chính sách Cookie
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-gray-500">
            © 2026 EzFormat Inc. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <Link
              to="#"
              className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
            >
              System Status
            </Link>
            <Link
              to="#"
              className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
            >
              Security Verification
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
