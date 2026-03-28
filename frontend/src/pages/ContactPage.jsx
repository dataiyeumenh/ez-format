import { useState } from "react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const ContactPage = () => {
  const [email, setEmail] = useState("");

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <main className="flex-1">
        {/* Header */}
        <section className="py-16 px-4 text-center bg-white border-b border-gray-100">
          <h1 className="text-4xl font-black text-gray-900">
            Liên hệ chúng tôi
          </h1>
        </section>

        {/* Contact info */}
        <section className="bg-white">
          <div className="max-w-5xl mx-auto px-4 py-16 grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
            <div>
              <h2 className="text-4xl font-black text-gray-900 leading-tight mb-4">
                Chúng tôi luôn sẵn sàng hỗ trợ bạn.
              </h2>
              <p className="text-gray-500 text-sm leading-relaxed">
                Dù bạn có thắc mắc kỹ thuật hay cần giải pháp nhận dạng, chúng
                tôi luôn sẵn sàng hỗ trợ để bạn nhanh chóng tập trung vào những
                công việc quan trọng hơn.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-1">
                  Địa chỉ Email
                </p>
                <p className="text-sm text-gray-500">—</p>
                <p className="text-sm text-gray-700 font-medium">
                  Ezformat@gmail.com
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-1">
                  Giờ hoạt động:
                </p>
                <p className="text-sm text-gray-500">Monday - Friday</p>
                <p className="text-sm text-gray-500">6 sáng đến 8 tối</p>
              </div>
            </div>
          </div>
        </section>

        {/* Newsletter */}
        <section className="bg-blue-600 py-14 px-4">
          <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
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
                className="flex-1 md:w-72 px-4 py-2.5 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-white/50"
              />
              <button className="bg-white text-blue-600 font-semibold px-5 py-2.5 rounded-lg hover:bg-blue-50 transition-colors text-sm whitespace-nowrap">
                Đăng ký
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
