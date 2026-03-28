import { Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import { useAuth } from "../context/AuthContext";

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
    description:
      "Lựa chọn tối ưu dành cho người dùng chuyên sâu và gói chuyên môn",
    buttonText: "Nâng cấp lên GÓI NĂM",
    buttonVariant: "primary",
    features: [
      "Các chức năng của gói tháng",
      "Không giới hạn files",
      "Bảo mật cao",
    ],
    popular: true,
  },
  {
    id: "perfile",
    name: "THEO LƯỢT",
    price: "5k",
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
        state: { planName: plan.name, planPrice: plan.price },
      });
    } else {
      navigate("/register");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 py-16 px-4">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="text-center mb-12">
            <h1 className="text-4xl sm:text-5xl font-black text-gray-900 mb-4">
              Lựa chọn gói dịch vụ phù hợp với nhu cầu của bạn
            </h1>
            <p className="text-gray-500 text-base max-w-lg mx-auto">
              Dành cho sinh viên và các chuyên gia. Chuyển đổi mọi loại biểu mẫu
              một cách nhanh chóng và chính xác.
            </p>
          </div>

          {/* Pricing cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-4">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="group relative bg-white rounded-2xl p-6 flex flex-col border border-gray-200 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-100 transition-all duration-200"
              >
                {/* Popular badge */}
                {plan.popular && (
                  <div className="absolute -top-3.5 left-0 right-0 flex justify-center">
                    <span className="whitespace-nowrap bg-blue-600 text-white text-xs font-bold px-4 py-1 rounded-full uppercase tracking-wider">
                      MOST POPULAR
                    </span>
                  </div>
                )}

                <div className="flex-1">
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
                    {plan.name}
                  </h3>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="text-3xl font-black text-gray-900">
                      {plan.price}
                    </span>
                    <span className="text-sm text-gray-500">{plan.period}</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-6 leading-relaxed">
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
                          className="text-blue-600 mt-0.5 flex-shrink-0"
                        />
                        <span className="text-xs text-gray-600">{feature}</span>
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
    </div>
  );
};

export default PricingPage;
