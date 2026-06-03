import { Link } from "react-router-dom";
import {
  FileSpreadsheet,
  Shield,
  Zap,
  ArrowRight,
  FileText,
  UploadCloud,
  Wand2,
  Eye,
  Download,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import StepProgress from "../components/ui/StepProgress";

const processSteps = ["Tải file", "Map cột", "Xem trước", "Tải MISA"];

const guideSteps = [
  {
    icon: UploadCloud,
    title: "Tải file Excel",
    text: "Chọn hoặc kéo thả file .xlsx/.xls bán hàng, mua hàng vào hệ thống.",
  },
  {
    icon: Wand2,
    title: "Kiểm tra mapping",
    text: "EzFormat gợi ý map cột sang mẫu MISA, bạn rà lại các dòng cảnh báo.",
  },
  {
    icon: Eye,
    title: "Xem trước & chỉnh sửa",
    text: "Sửa trực tiếp trên bảng preview trước khi xuất file chuẩn.",
  },
  {
    icon: Download,
    title: "Tải file Misa",
    text: "Xuất file kết quả để import vào phần mềm MISA.",
  },
];

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
        <section className="landing-hero-gradient py-14 sm:py-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-6xl mx-auto text-center">
            <h1
              className="font-black text-gray-900 leading-[1.05] tracking-tight mb-4"
              aria-label="Chuẩn hóa dữ liệu kế toán tự động Excel sang Misa"
            >
              <span className="mx-auto block whitespace-nowrap text-[2rem] sm:text-4xl lg:text-5xl">
                Chuẩn hóa dữ liệu kế toán tự động
              </span>
              <span className="mt-3 flex items-center justify-center text-3xl sm:text-5xl lg:text-6xl">
                <span className="text-green-600">Excel</span>
                <svg
                  className="mx-3 h-7 w-12 text-gray-900 sm:mx-4 sm:h-10 sm:w-16"
                  viewBox="0 0 64 32"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 16H56M44 5L56 16L44 27"
                    stroke="currentColor"
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-cyan-500">
                  Misa
                </span>
              </span>
            </h1>
            <p className="text-gray-500 text-base sm:text-lg max-w-3xl mx-auto leading-relaxed mb-8">
              <span className="block">
                Nền tảng chuyển đổi file bán/mua hàng sang form nhập MISA.
              </span>
              <span className="block">Xem trước, chỉnh sửa và tải về trong vài bước.</span>
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-8">
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

            <div className="grid gap-6 rounded-[2rem] border border-white/80 bg-white/85 p-4 text-left shadow-card backdrop-blur sm:p-6 lg:grid-cols-[1.15fr_0.85fr] mb-8">
              <div
                className="flex h-full overflow-hidden rounded-3xl border border-gray-100 bg-gradient-to-br from-gray-50 to-primary-50/60 p-4 shadow-inner"
                role="img"
                aria-label="Minh họa giao diện quá trình chuyển đổi Excel sang Misa"
              >
                <div className="flex min-h-[390px] w-full flex-col rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                  <div className="mb-4 flex items-center justify-between border-b border-gray-100 pb-3">
                    <div className="flex items-center gap-1.5" aria-hidden="true">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                    </div>
                    <span className="rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700">
                      Preview MISA
                    </span>
                  </div>

                  <StepProgress steps={processSteps} current={2} />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/80 p-3">
                      <p className="mb-2 text-xs font-bold text-emerald-700">
                        Excel nguồn
                      </p>
                      <div className="space-y-2" aria-hidden="true">
                        <span className="block h-2 rounded-full bg-emerald-200" />
                        <span className="block h-2 rounded-full bg-emerald-300" />
                        <span className="block h-2 w-2/3 rounded-full bg-emerald-200" />
                      </div>
                    </div>
                    <div className="rounded-2xl border border-primary-100 bg-primary-50/80 p-3">
                      <p className="mb-2 text-xs font-bold text-primary-700">Map cột</p>
                      <svg
                        className="h-12 w-full text-primary-500"
                        viewBox="0 0 160 48"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M16 12H108C126 12 126 36 144 36M16 36H92C110 36 112 12 144 12"
                          stroke="currentColor"
                          strokeWidth="4"
                          strokeLinecap="round"
                        />
                        <circle cx="16" cy="12" r="5" fill="currentColor" />
                        <circle cx="16" cy="36" r="5" fill="currentColor" />
                        <circle cx="144" cy="12" r="5" fill="currentColor" />
                        <circle cx="144" cy="36" r="5" fill="currentColor" />
                      </svg>
                    </div>
                    <div className="rounded-2xl border border-cyan-100 bg-cyan-50/80 p-3">
                      <p className="mb-2 text-xs font-bold text-cyan-700">File Misa</p>
                      <div className="space-y-2" aria-hidden="true">
                        <span className="block h-2 rounded-full bg-cyan-300" />
                        <span className="block h-2 w-4/5 rounded-full bg-cyan-200" />
                        <span className="block h-2 rounded-full bg-cyan-300" />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex-1 rounded-2xl border border-gray-100 bg-gray-50/80 p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-xs font-bold text-gray-700">Bảng xem trước</p>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                        Sẵn sàng tải
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2" aria-hidden="true">
                      {Array.from({ length: 16 }).map((_, index) => (
                        <span
                          key={index}
                          className={`h-3 rounded-full ${
                            index < 4
                              ? "bg-primary-200"
                              : index % 3 === 0
                                ? "bg-emerald-200"
                                : "bg-gray-200"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-center">
                <p className="text-sm font-semibold uppercase tracking-wide text-primary-600">
                  Cách thực hiện
                </p>
                <h2 className="mt-2 text-2xl font-black text-gray-900">
                  Chuyển Excel sang Misa trong 4 bước
                </h2>
                <div className="mt-5 space-y-4">
                  {guideSteps.map(({ icon: Icon, title, text }, index) => (
                    <div key={title} className="flex gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary-50 text-primary-600">
                        <Icon size={18} />
                      </div>
                      <div>
                        <p className="font-bold text-gray-900">
                          {index + 1}. {title}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-gray-500">
                          {text}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
