import { Check, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import ChatSupport from "../components/ChatSupport";
import { useAuth } from "../context/AuthContext";
import api from "../services/api";

const PricingPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [plansError, setPlansError] = useState("");

  useEffect(() => {
    let mounted = true;
    const loadPlans = async () => {
      try {
        const { data } = await api.get("/plans");
        if (mounted) setPlans(data.plans || []);
      } catch (error) {
        if (mounted) {
          setPlansError(
            error.response?.data?.message || "Không thể tải danh sách gói dịch vụ.",
          );
        }
      } finally {
        if (mounted) setLoadingPlans(false);
      }
    };
    loadPlans();
    return () => {
      mounted = false;
    };
  }, []);

  const handlePlanClick = (plan) => {
    if (plan.code === "free" || Number(plan.price || 0) <= 0) {
      navigate(user ? "/convert" : "/register");
      return;
    }
    if (user && user.role !== "admin") {
      navigate("/payment", {
        state: {
          planId: plan.id,
          planCode: plan.code,
          planName: plan.name,
          planPrice: plan.displayPrice,
          plan,
        },
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
          </div>

          {/* Pricing cards */}
          {loadingPlans && (
            <div className="flex items-center justify-center py-16 text-blue-600">
              <Loader2 size={24} className="animate-spin" />
            </div>
          )}
          {plansError && (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
              {plansError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-4">
            {plans.map((plan, index) => (
              <div
                key={plan.id}
                className={`animate-fade-up-in group relative flex flex-col rounded-2xl p-6 transition-all duration-200 ${
                  plan.isPopular
                    ? "bg-gradient-to-br from-blue-50 via-white to-cyan-50 border-2 border-blue-500 shadow-xl shadow-blue-100/80 lg:-translate-y-3 lg:scale-[1.03]"
                    : "bg-white border border-gray-200 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-100"
                }`}
                style={{ animationDelay: `${320 + index * 140}ms` }}
              >
                {/* Popular badge */}
                {plan.isPopular && (
                  <div className="absolute -top-3.5 left-0 right-0 flex justify-center">
                    <span className="whitespace-nowrap rounded-full bg-blue-600 px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-blue-200">
                      PHỔ BIẾN
                    </span>
                  </div>
                )}

                <div className="flex-1">
                  <h3
                    className={`mb-3 text-xs font-bold uppercase tracking-wider ${
                      plan.isPopular ? "text-blue-700" : "text-gray-500"
                    }`}
                  >
                    {plan.name}
                  </h3>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span
                      className={`text-3xl font-black ${
                        plan.isPopular ? "text-blue-700" : "text-gray-900"
                      }`}
                    >
                      {plan.displayPrice}
                    </span>
                    <span
                      className={`text-sm ${
                        plan.isPopular ? "text-blue-500" : "text-gray-500"
                      }`}
                    >
                      {plan.periodLabel}
                    </span>
                  </div>
                  <p
                    className={`mb-6 text-xs leading-relaxed ${
                      plan.isPopular ? "text-gray-600" : "text-gray-500"
                    }`}
                  >
                    {plan.description}
                  </p>

                  <button
                    onClick={() => handlePlanClick(plan)}
                    className={`block w-full text-center py-2.5 rounded-xl text-sm font-semibold transition-colors mb-6 ${
                      plan.isPopular
                        ? "bg-blue-600 hover:bg-blue-700 text-white"
                        : "border border-gray-300 hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    {plan.code === "free" ? "Bắt đầu" : `Nâng cấp lên ${plan.name}`}
                  </button>

                  <ul className="space-y-2.5">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Check
                          size={15}
                          className={`mt-0.5 flex-shrink-0 ${
                            plan.isPopular ? "text-blue-700" : "text-blue-600"
                          }`}
                        />
                        <span
                          className={`text-xs ${
                            plan.isPopular ? "font-medium text-gray-700" : "text-gray-600"
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
