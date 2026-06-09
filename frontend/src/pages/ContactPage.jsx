import { useState } from "react";
import { Clock, Mail, MessageCircle, Send } from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const ContactPage = () => {
  const [email, setEmail] = useState("");

  return (
    <div className="min-h-screen flex flex-col bg-mesh">
      <Navbar />

      <main className="flex-1">
        {/* Header */}
        <section className="landing-hero-gradient px-4 py-16 text-center sm:py-20">
          <div className="mx-auto max-w-3xl">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-600 text-white shadow-glow">
              <MessageCircle size={28} />
            </div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary-600">
              Hỗ trợ EzFormat
            </p>
            <h1 className="text-4xl font-black tracking-tight text-gray-900 sm:text-5xl">
              Liên hệ chúng tôi
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-gray-600">
              Cần hỗ trợ chuyển đổi Excel sang Misa, bảng giá hoặc tài khoản? Gửi
              thông tin cho chúng tôi, EzFormat sẽ phản hồi nhanh nhất có thể.
            </p>
          </div>
        </section>

        {/* Contact info */}
        <section className="bg-gradient-to-b from-white via-primary-50/30 to-white px-4 py-14 sm:py-16">
          <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-[1fr_0.9fr] gap-8 items-stretch">
            <div>
              <div className="h-full rounded-[2rem] border border-white/80 bg-white/85 p-6 shadow-card backdrop-blur sm:p-8">
              <h2 className="text-4xl font-black text-gray-900 leading-tight mb-4">
                Chúng tôi luôn sẵn sàng hỗ trợ bạn.
              </h2>
              <p className="text-gray-600 text-base leading-relaxed">
                Dù bạn có thắc mắc kỹ thuật hay cần giải pháp nhận dạng, chúng tôi luôn
                sẵn sàng hỗ trợ để bạn nhanh chóng tập trung vào những công việc quan
                trọng hơn.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {["Phản hồi rõ ràng", "Hỗ trợ quy trình chuyển đổi"].map((item) => (
                  <div
                    key={item}
                    className="rounded-2xl border border-primary-100 bg-primary-50/60 px-4 py-3 text-sm font-semibold text-primary-700"
                  >
                    {item}
                  </div>
                ))}
              </div>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-[2rem] border border-gray-100 bg-white p-6 shadow-card">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-600">
                  <Mail size={24} />
                </div>
                <p className="text-sm font-semibold uppercase tracking-wide text-primary-600 mb-2">
                  Địa chỉ Email
                </p>
                <a
                  href="mailto:ezformat.io.vn@gmail.com"
                  className="text-lg font-black text-gray-900 transition-colors hover:text-primary-600"
                >
                  ezformat.io.vn@gmail.com
                </a>
              </div>

              <div className="rounded-[2rem] border border-gray-100 bg-white p-6 shadow-card">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-600">
                  <Clock size={24} />
                </div>
                <p className="text-sm font-semibold uppercase tracking-wide text-cyan-700 mb-2">
                  Giờ hoạt động:
                </p>
                <p className="text-base font-bold text-gray-900">Thứ Hai - Thứ Sáu</p>
                <p className="text-sm text-gray-500">7 giờ sáng - 8 giờ tối</p>
              </div>
            </div>
          </div>
        </section>

        {/* Newsletter */}
        <section className="bg-gradient-to-r from-primary-600 via-blue-600 to-cyan-600 py-14 px-4">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
            <div>
              <h3 className="text-2xl font-black text-white mb-2">
                Đăng ký nhận tin tức mới nhất
              </h3>
              <p className="text-blue-100 text-sm">
                Đăng ký để luôn cập nhật các tính năng và thông báo mới nhất.
              </p>
            </div>
            <div className="flex items-center gap-3 w-full md:w-auto">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Địa chỉ email của bạn"
                className="flex-1 md:w-80 px-4 py-3 rounded-xl text-sm text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-white/50"
              />
              <button className="inline-flex items-center gap-2 bg-white text-blue-600 font-semibold px-5 py-3 rounded-xl hover:bg-blue-50 transition-colors text-sm whitespace-nowrap shadow-sm">
                Đăng ký
                <Send size={15} />
              </button>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default ContactPage;
