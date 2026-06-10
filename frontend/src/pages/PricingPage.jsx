import { Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import ChatSupport from "../components/ChatSupport";
import { useAuth } from "../context/AuthContext";
import UserPlanBadge from "../components/UserPlanBadge";

const plans = [
  {
    id: "free",
    name: "GÓI MIỄN PHÍ",
    price: "0đ",
    period: "/mo",
    description: "Phù hợp để tham khảo các chức năng cơ bản",
    buttonText: "Bắt đầu",
    buttonVariant: "outline",
    features: ["Chức năng cơ bản", "Giới hạn 3 files", "Thu thập dữ liệu"],
    popular: false,
  },
  {
    id: "monthly",
    name: "GÓI THÁNG",
    price: "149k",
    period: "/tháng",
    description: "Phù hợp cho mọi loại tình huống, tăng hiệu suất công việc",
    buttonText: "Nâng cấp lên GÓI THÁNG",
    buttonVariant: "outline",
    features: ["Chức năng bảng thống kê", "Không quảng cáo"],
    popular: false,
  },
  {
    id: "yearly",
    name: "GÓI NĂM",
    price: "109k",
    period: "/tháng",
    description: "Lựa chọn tối ưu dành cho người dùng chuyên sâu và gói chuyên môn",
    buttonText: "Nâng cấp lên GÓI NĂM",
    buttonVariant: "primary",
    features: ["Các chức năng của gói tháng", "Không giới hạn files", "Bảo mật cao"],
    popular: true,
  },
  {
    id: "perfile",
    name: "THEO LƯỢT",
    price: "10k",
    period: "/ 1 file",
    description: "Phù hợp cho mỗi lần sử dụng",
    buttonText: "Nâng cấp",
    buttonVariant: "outline",
    features: ["Các chức năng của gói miễn phí", "Không quảng cáo"],
    popular: false,
  },
];

const PricingPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const handlePlanClick = (plan) => {
    if (user && user.role !== "admin") {
      navigate("/payment", {
        state: { planType: plan.id, planName: plan.name, planPrice: plan.price },
      });
    } else {
      navigate("/register");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 py-16 px-4">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div
            className="animate-fade-up-in text-center mb-12"
            style={{ animationDelay: "120ms" }}
          >
            <h1 className="mb-4 text-4xl font-black leading-[1.22] text-gray-900 sm:text-5xl sm:leading-[1.18]">
              <span className="block">Lựa chọn gói dịch vụ</span>
              <span className="block">phù hợp với nhu cầu của bạn</span>
            </h1>
            <p className="text-gray-500 text-base max-w-lg mx-auto">
              Dành cho sinh viên và các chuyên gia. Chuyển đổi mọi loại biểu mẫu một
              cách nhanh chóng và chính xác.
            </p>
            {user && (
              <div
                className="animate-fade-up-in mt-5 max-w-md mx-auto text-left"
                style={{ animationDelay: "300ms" }}
              >
                <UserPlanBadge user={user} />
              </div>
            )}
          </div>

          {/* Pricing cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-4">
            {plans.map((plan, index) => (
              <div
                key={plan.id}
                className={`animate-fade-up-in group relative flex flex-col rounded-2xl p-6 transition-all duration-200 ${
                  plan.popular
                    ? "bg-gradient-to-br from-blue-50 via-white to-cyan-50 border-2 border-blue-500 shadow-xl shadow-blue-100/80 lg:-translate-y-3 lg:scale-[1.03]"
                    : "bg-white border border-gray-200 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-100"
                }`}
                style={{ animationDelay: `${320 + index * 140}ms` }}
              >
                {/* Popular badge */}
                {plan.popular && (
                  <div className="absolute -top-3.5 left-0 right-0 flex justify-center">
                    <span className="whitespace-nowrap rounded-full bg-blue-600 px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-blue-200">
                      MOST POPULAR
                    </span>
                  </div>
                )}

                <div className="flex-1">
                  <h3
                    className={`mb-3 text-xs font-bold uppercase tracking-wider ${
                      plan.popular ? "text-blue-700" : "text-gray-500"
                    }`}
                  >
                    {plan.name}
                  </h3>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span
                      className={`text-3xl font-black ${
                        plan.popular ? "text-blue-700" : "text-gray-900"
                      }`}
                    >
                      {plan.price}
                    </span>
                    <span
                      className={`text-sm ${
                        plan.popular ? "text-blue-500" : "text-gray-500"
                      }`}
                    >
                      {plan.period}
                    </span>
                  </div>
                  <p
                    className={`mb-6 text-xs leading-relaxed ${
                      plan.popular ? "text-gray-600" : "text-gray-500"
                    }`}
                  >
                    {plan.description}
                  </p>

                  <button
                    onClick={() => handlePlanClick(plan)}
                    className={`block w-full text-center py-2.5 rounded-xl text-sm font-semibold transition-colors mb-6 ${
                      plan.buttonVariant === "primary"
                        ? "bg-blue-600 hover:bg-blue-700 text-white"
                        : "border border-gray-300 hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    {plan.buttonText}
                  </button>

                  <ul className="space-y-2.5">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Check
                          size={15}
                          className={`mt-0.5 flex-shrink-0 ${
                            plan.popular ? "text-blue-700" : "text-blue-600"
                          }`}
                        />
                        <span
                          className={`text-xs ${
                            plan.popular ? "font-medium text-gray-700" : "text-gray-600"
                          }`}
                        >
                          {feature}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
      <Footer />
      <ChatSupport />
    </div>
  );
};

export default PricingPage;
