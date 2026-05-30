import { Link } from "react-router-dom";
import {
  Sparkles,
  FileSpreadsheet,
  Shield,
  Zap,
  ArrowRight,
  FileText,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const features = [
  {
    icon: FileSpreadsheet,
    title: "Excel → MISA",
    text: "Sáu loại form nhập: bán hàng, mua hàng, BSN và dịch vụ.",
  },
  {
    icon: Shield,
    title: "Kiểm tra trước khi tải",
    text: "Nhận diện cột tự động, cảnh báo lỗi và xem trước từng dòng.",
  },
  {
    icon: Zap,
    title: "Chỉnh sửa trực tiếp",
    text: "Sửa ô trên bảng xem trước rồi xuất file .xls chuẩn MISA.",
  },
];

const LandingPage = () => {
  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />

      <main className="flex-1">
        <section className="py-14 sm:py-20 px-4">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-white/80 backdrop-blur border border-primary-100 text-primary-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-6 shadow-sm">
              <Sparkles size={14} className="text-primary-500" />
              Chuẩn hóa dữ liệu kế toán tự động
            </div>

            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black text-gray-900 leading-[1.1] tracking-tight mb-4">
              EzFormat — từ Excel sang{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-cyan-500">
                MISA
              </span>
            </h1>
            <p className="text-gray-500 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed mb-8">
              Nền tảng chuyển đổi file bán/mua hàng sang form nhập MISA. Xem trước,
              chỉnh sửa và tải về trong vài bước.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
              <Link
                to="/convert"
                className="btn-primary w-full sm:w-auto py-3.5 px-8 text-base"
              >
                Bắt đầu chuyển đổi
                <ArrowRight size={18} />
              </Link>
              <Link
                to="/pricing"
                className="btn-secondary w-full sm:w-auto py-3.5 px-8 text-base"
              >
                Xem bảng giá
              </Link>
            </div>

            <div className="rounded-2xl border border-amber-100 bg-amber-50/80 px-4 py-3 text-left sm:text-center max-w-xl mx-auto">
              <p className="text-sm text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium shrink-0">
                  <FileText size={16} />
                  PDF
                </span>
                <span>
                  Hiện chỉ hỗ trợ <strong>Excel (.xlsx, .xls)</strong>. Chuyển PDF sang
                  Excel từ phần mềm nguồn trước khi upload.
                </span>
              </p>
            </div>
          </div>
        </section>

        <section className="py-12 sm:py-16 px-4 bg-white/60 border-y border-gray-100">
          <div className="max-w-5xl mx-auto grid gap-6 sm:grid-cols-3">
            {features.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm hover:shadow-card transition-shadow"
              >
                <div className="w-11 h-11 rounded-xl bg-primary-50 flex items-center justify-center mb-4">
                  <Icon size={22} className="text-primary-600" />
                </div>
                <h3 className="font-bold text-gray-900 mb-2">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="py-14 px-4 text-center">
          <p className="text-gray-500 text-sm mb-4">Sẵn sàng thử với file của bạn?</p>
          <Link to="/convert" className="btn-primary inline-flex">
            <FileSpreadsheet size={18} />
            Mở trang chuyển đổi
          </Link>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default LandingPage;
