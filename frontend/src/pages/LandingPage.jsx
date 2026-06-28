import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  FileSpreadsheet,
  Shield,
  ArrowRight,
  FileText,
  Check,
  UploadCloud,
  Wand2,
  Eye,
  Download,
  HelpCircle,
} from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import ChatSupport from "../components/ChatSupport";
import StepProgress from "../components/ui/StepProgress";

const processSteps = ["Tải file lên", "Map cột", "Xem trước", "Tải xuống file kết quả"];

const guideSteps = [
  {
    icon: UploadCloud,
    title: "Tải lên file Excel",
    text: "Chọn hoặc kéo thả file .xlsx/.xls bán hàng, mua hàng vào hệ thống.",
  },
  {
    icon: Wand2,
    title: "Kiểm tra mapping",
    text: "EzFormat gợi ý map cột sang mẫu chuẩn cho phần mềm kế toán, bạn rà lại các dòng cảnh báo.",
  },
  {
    icon: Eye,
    title: "Xem trước & chỉnh sửa",
    text: "Sửa trực tiếp trên bảng preview trước khi xuất file chuẩn.",
  },
  {
    icon: Download,
    title: "Tải xuống file đã chuẩn hoá",
    text: "Xuất file kết quả để import vào phần mềm dành cho kế toán.",
  },
];

const faqs = [
  {
    question: "EzFormat hỗ trợ loại file nào?",
    answer:
      "Hiện EzFormat hỗ trợ file Excel .xlsx và .xls. Nếu dữ liệu đang ở PDF, bạn cần xuất hoặc chuyển sang Excel trước khi upload.",
  },
  {
    question: "Tôi có thể xem trước dữ liệu trước khi tải về không?",
    answer:
      "Có. Sau khi hệ thống map cột, bạn có thể xem trước dữ liệu, rà lại cảnh báo và chỉnh sửa trước khi xuất file Misa.",
  },
  {
    question: "Dữ liệu kế toán của tôi có được bảo mật không?",
    answer:
      "EzFormat được thiết kế để chỉ dùng dữ liệu cho quy trình xử lý file của bạn và không chia sẻ dữ liệu cho bên thứ ba trong quá trình chuyển đổi.",
  },
  {
    question: "Tôi nên chọn gói nào?",
    answer:
      "Nếu chỉ dùng thử, bạn có thể bắt đầu với gói miễn phí. Nếu chuyển đổi thường xuyên, gói tháng hoặc gói năm sẽ phù hợp hơn.",
  },
  {
    question: "File xuất ra có dùng để nhập vào MISA không?",
    answer:
      "Có. Mục tiêu của EzFormat là chuẩn hóa dữ liệu Excel sang form nhập MISA để bạn kiểm tra, chỉnh sửa và tải về trong vài bước.",
  },
];

const LandingPage = () => {
  const { user } = useAuth();
  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />

      <main className="flex-1">
        <section className="landing-hero-gradient py-14 sm:py-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-6xl mx-auto text-center">
            <h1
              className="font-black text-gray-900 leading-[1.05] tracking-tight mb-4"
              aria-label="Chuẩn hóa dữ liệu kế toán tự động Excel sang Chuẩn phần mềm kế toán"
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
                  Phần mềm kế toán
                </span>
              </span>
            </h1>
            <p className="text-gray-500 text-base sm:text-lg max-w-3xl mx-auto leading-relaxed mb-8">
              <span className="block">
                Nền tảng chuyển đổi file bán/mua hàng sang form nhập Chuẩn phần mềm kế toán.
              </span>
              <span className="block">Xem trước, chỉnh sửa và tải về trong vài bước.</span>
            </p>

            {!user && (
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-8">
                <Link
                  to="/convert"
                  className="btn-primary w-full sm:w-auto py-3.5 px-8 text-base"
                >
                  Trải nghiệm ngay
                  <ArrowRight size={18} />
                </Link>
              </div>
            )}

            <div className="grid gap-6 rounded-[2rem] border border-white/80 bg-white/85 p-4 text-left shadow-card backdrop-blur sm:p-6 lg:grid-cols-[1.15fr_0.85fr] mb-8">
              <div
                className="flex h-full overflow-hidden rounded-3xl border border-gray-100 bg-gradient-to-br from-gray-50 to-primary-50/60 p-4 shadow-inner"
                role="img"
                aria-label="Minh họa giao diện quá trình chuyển đổi Excel sang Chuẩn phần mềm kế toán"
              >
                <div className="flex min-h-[390px] w-full flex-col rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                  <div className="mb-4 flex items-center justify-between border-b border-gray-100 pb-3">
                    <div className="flex items-center gap-1.5" aria-hidden="true">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                    </div>
                    <span className="rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700">
                      Preview
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
                      <p className="mb-2 text-xs font-bold text-cyan-700">File kết quả</p>
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
                  Chuyển Excel sang Chuẩn phần mềm kế toán trong 4 bước
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

        <section className="bg-white px-4 py-6 sm:py-8">
          <div className="max-w-6xl mx-auto">
            <div className="grid gap-8 rounded-[2rem] border border-primary-100 bg-gradient-to-br from-primary-50 via-white to-cyan-50 p-6 shadow-card sm:p-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
              <div>
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-600 text-white shadow-glow">
                  <Shield size={28} />
                </div>
                <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary-600">
                  An toàn dữ liệu
                </p>
                <h2 className="text-3xl font-black leading-tight text-gray-900 sm:text-4xl">
                  Bảo mật dữ liệu tuyệt đối trong từng lần chuyển đổi
                </h2>
                <p className="mt-4 text-base leading-relaxed text-gray-600">
                  EzFormat được thiết kế để người dùng yên tâm khi xử lý dữ liệu kế
                  toán, hạn chế thao tác thủ công và giảm rủi ro lộ thông tin trong
                  quá trình chuẩn hóa file.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  "Không chia sẻ dữ liệu cho bên thứ ba khi chuyển đổi.",
                  "Chỉ dùng dữ liệu cho đúng quy trình xử lý file của bạn.",
                  "Giao diện xem trước giúp kiểm tra nội dung trước khi tải về.",
                  "Quy trình rõ ràng, giảm gửi nhầm file và thao tác ngoài hệ thống.",
                ].map((item) => (
                  <div
                    key={item}
                    className="flex gap-3 rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm"
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                      <Check size={16} />
                    </div>
                    <p className="text-sm font-medium leading-relaxed text-gray-700">
                      {item}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden bg-white px-4 py-14 sm:py-16">
          <div className="relative max-w-4xl mx-auto">
            <div className="text-center mb-10">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-600 text-white shadow-glow">
                <HelpCircle size={28} />
              </div>
              <p className="text-sm font-semibold uppercase tracking-wide text-primary-600 mb-2">
                Giải đáp nhanh
              </p>
              <h2 className="text-3xl sm:text-4xl font-black text-gray-900">
                Câu hỏi thường gặp
              </h2>
              <p className="mt-3 text-base text-gray-500">
                Các thắc mắc phổ biến khi chuyển đổi Excel sang Misa bằng EzFormat.
              </p>
            </div>

            <div className="space-y-3 rounded-[2rem] border border-white/80 bg-white/70 p-3 shadow-card backdrop-blur sm:p-4">
              {faqs.map((faq, index) => (
                <details
                  key={faq.question}
                  className="group rounded-2xl border border-gray-100 bg-white p-5 shadow-sm open:border-primary-100 open:shadow-card"
                  open={index === 0}
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-bold text-gray-900">
                    <span>{faq.question}</span>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-600 transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <ChatSupport />
    </div>
  );
};

export default LandingPage;
