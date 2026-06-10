import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import { useAuth } from "../context/AuthContext";
import UserPlanBadge from "../components/UserPlanBadge";

const copy = {
  success: {
    icon: CheckCircle,
    title: "Thanh toán đang được xác nhận",
    desc: "Nếu giao dịch thành công, hệ thống sẽ tự động nâng gói khi payOS gửi webhook. Vui lòng chờ vài giây rồi kiểm tra lại tài khoản.",
    tone: "text-emerald-600 bg-emerald-50",
  },
  cancel: {
    icon: XCircle,
    title: "Thanh toán đã huỷ",
    desc: "Bạn có thể quay lại bảng giá để tạo đơn thanh toán mới bất cứ lúc nào.",
    tone: "text-red-600 bg-red-50",
  },
};

const PaymentResultPage = ({ status = "success" }) => {
  const { user, refreshUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [refreshing, setRefreshing] = useState(status === "success");
  const config = copy[status] || copy.success;
  const Icon = config.icon;
  const orderCode = searchParams.get("orderCode");

  useEffect(() => {
    if (status !== "success") return;
    let cancelled = false;
    let attempts = 0;

    const refreshUntilUpdated = async () => {
      attempts += 1;
      try {
        const updatedUser = await refreshUser();
        const hasPaidBenefit =
          updatedUser?.plan === "Monthly" ||
          updatedUser?.plan === "Yearly" ||
          Number(updatedUser?.fileCredits || 0) > 0;
        if (hasPaidBenefit || attempts >= 6) {
          if (!cancelled) setRefreshing(false);
          return;
        }
      } catch {
        if (attempts >= 6 && !cancelled) setRefreshing(false);
      }

      if (!cancelled) {
        window.setTimeout(refreshUntilUpdated, 2500);
      }
    };

    const timer = window.setTimeout(refreshUntilUpdated, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshUser, status]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="max-w-lg w-full rounded-3xl border border-gray-100 bg-white p-8 text-center shadow-sm">
          <div
            className={`mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl ${config.tone}`}
          >
            <Icon size={34} />
          </div>
          <h1 className="text-2xl font-black text-gray-900 mb-3">{config.title}</h1>
          <p className="text-sm leading-relaxed text-gray-500 mb-4">{config.desc}</p>
          {orderCode && (
            <p className="mb-5 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600">
              Mã đơn hàng: <span className="font-semibold">{orderCode}</span>
            </p>
          )}
          {refreshing && (
            <p className="mb-5 flex items-center justify-center gap-2 text-sm text-blue-600">
              <Loader2 size={16} className="animate-spin" />
              Đang cập nhật thông tin tài khoản...
            </p>
          )}
          {status === "success" && user && (
            <div className="mb-5 text-left">
              <p className="mb-2 text-sm font-semibold text-gray-700">
                Gói hiện tại của bạn
              </p>
              <UserPlanBadge user={user} />
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              to="/pricing"
              className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Về bảng giá
            </Link>
            <Link
              to="/convert"
              className="flex-1 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Chuyển đổi file
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default PaymentResultPage;
