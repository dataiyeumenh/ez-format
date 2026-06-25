import { Link } from "react-router-dom";
import ezFormatLogo from "../assets/ezformat-main-logo.png";

const Footer = () => {
  return (
    <footer className="bg-gray-900 text-gray-300">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-4">
            <Link to="/" className="flex items-center gap-2">
              <img
                src={ezFormatLogo}
                alt="EzFormat logo"
                className="h-9 w-9 rounded-sm object-contain"
              />
              <span className="font-bold text-white text-lg">EzFormat</span>
            </Link>
            <p className="text-sm text-gray-400 leading-relaxed">
              Chuẩn hoá dữ liệu kế toán — chuyển Excel sang form nhập MISA nhanh và
              chính xác.
            </p>
          </div>

          <div className="space-y-3">
            <h4 className="font-semibold text-white text-sm uppercase tracking-wider">
              Hỗ trợ
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  to="/contact"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Liên hệ
                </Link>
              </li>
              <li>
                <Link
                  to="/login"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Đăng nhập
                </Link>
              </li>
              <li>
                <Link
                  to="/register"
                  className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Đăng ký
                </Link>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <h4 className="font-semibold text-white text-sm uppercase tracking-wider">
              Pháp lý
            </h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li>Quyền riêng tư (sắp có)</li>
              <li>Điều khoản dịch vụ (sắp có)</li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
