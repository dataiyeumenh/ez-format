import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FileText, Loader2, Tag } from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import api from "../services/api";
import { useAuth } from "../context/AuthContext";
import { resolvePaymentNavigation } from "../utils/paymentFlow";

function formatVnd(amount) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));
}

const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [applyingCoupon, setApplyingCoupon] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState(null);

  const selectedPlan = location.state?.plan;
  const planId = location.state?.planId || selectedPlan?.id;
  const planCode = location.state?.planCode || selectedPlan?.code;
  const originalAmount = Number(
    selectedPlan?.price ?? location.state?.planPriceAmount ?? 0,
  );

  const plan = useMemo(
    () => ({
      name: selectedPlan?.name || location.state?.planName || "Gói EzFormat",
      priceLabel: selectedPlan?.price
        ? formatVnd(selectedPlan.price)
        : location.state?.planPrice || formatVnd(originalAmount),
      description:
        selectedPlan?.code === "perfile"
          ? `Cộng ${selectedPlan.fileCredits || 1} lượt chuyển đổi`
          : selectedPlan?.durationDays
            ? `Gia hạn ${selectedPlan.durationDays} ngày`
            : "Thanh toán EzFormat",
    }),
    [location.state?.planName, location.state?.planPrice, originalAmount, selectedPlan],
  );

  const discountAmount = Number(appliedCoupon?.discountAmount || 0);
  const finalAmount = appliedCoupon
    ? Number(appliedCoupon.finalAmount || 0)
    : originalAmount;

  const handleApplyCoupon = async () => {
    if (!user) {
      navigate("/login");
      return;
    }
    if (!planId && !planCode) {
      setCouponError("Vui lòng chọn lại gói thanh toán.");
      return;
    }
    const code = couponInput.trim().toUpperCase();
    if (!code) {
      setCouponError("Vui lòng nhập mã giảm giá.");
      return;
    }

    setApplyingCoupon(true);
    setCouponError("");
    setErrorMsg("");
    try {
      const { data } = await api.post("/payments/preview-coupon", {
        planId,
        planCode,
        couponCode: code,
      });
      setAppliedCoupon({
        code: data.coupon?.code || code,
        description: data.coupon?.description || "",
        discountPercent: data.coupon?.discountPercent,
        discountAmount: data.discountAmount,
        finalAmount: data.finalAmount,
        originalAmount: data.originalAmount,
      });
      setCouponInput(data.coupon?.code || code);
    } catch (error) {
      setAppliedCoupon(null);
      setCouponError(
        error.response?.data?.message ||
          error.message ||
          "Không thể áp dụng mã giảm giá.",
      );
    } finally {
      setApplyingCoupon(false);
    }
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null);
    setCouponError("");
  };

  const handleCreatePayment = async () => {
    if (!user) {
      navigate("/login");
      return;
    }
    if (!planId && !planCode) {
      setErrorMsg("Vui lòng chọn lại gói thanh toán.");
      return;
    }

    setLoading(true);
    setErrorMsg("");
    try {
      const response = await api.post("/payments/create", {
        planId,
        planCode,
        couponCode: appliedCoupon?.code || undefined,
      });
      const destination = resolvePaymentNavigation(response.data);
      if (destination.mode === "internal") {
        navigate(destination.href, { replace: true });
        return;
      }
      window.location.assign(destination.href);
    } catch (error) {
      setErrorMsg(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "Không thể tạo link thanh toán payOS.",
      );
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 py-10 px-4">
        <h1 className="text-3xl font-black text-gray-900 text-center mb-8">
          Thanh Toán
        </h1>

        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="p-6 border-r border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">
                Phương thức thanh toán
              </h2>
              <div className="rounded-xl border border-blue-500 bg-blue-600 p-4 text-white">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-lg">🏦</span>
                  <span className="text-sm font-semibold">
                    Thanh toán qua Internet Banking
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-blue-100">
                  Bạn muốn thanh toán ngay qua ngân hàng trực tuyến? Chỉ cần chọn ngân
                  hàng và tiến hành giao dịch.
                </p>
              </div>
            </div>

            <div className="p-6 bg-gray-50/50 flex flex-col">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">
                Đơn hàng của bạn
              </h2>

              <div className="bg-white rounded-xl border border-gray-100 p-4 flex-1">
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">{plan.name}</span>
                    <span className="font-medium text-gray-700">{plan.priceLabel}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Số lượng</span>
                    <span className="font-medium text-gray-700">1</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Quyền lợi</span>
                    <span className="font-medium text-gray-700 text-right max-w-[55%]">
                      {plan.description}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Áp dụng ưu đãi</span>
                    <span className="font-medium text-green-600">
                      -{formatVnd(discountAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Thuế</span>
                    <span className="font-medium text-gray-700">0 VND</span>
                  </div>
                </div>

                <form
                  className="mt-4 rounded-xl border border-dashed border-gray-200 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleApplyCoupon();
                  }}
                >
                  <label
                    htmlFor="payment-coupon"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500"
                  >
                    <Tag size={12} />
                    Mã giảm giá
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="payment-coupon"
                      type="text"
                      value={couponInput}
                      onChange={(event) => {
                        setCouponInput(event.target.value.toUpperCase());
                        if (appliedCoupon) setAppliedCoupon(null);
                        setCouponError("");
                      }}
                      placeholder="Nhập mã coupon"
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm uppercase focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    {appliedCoupon ? (
                      <button
                        type="submit"
                        onClick={handleRemoveCoupon}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
                      >
                        Gỡ
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleApplyCoupon}
                        disabled={applyingCoupon}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
                      >
                        {applyingCoupon && (
                          <Loader2 size={14} className="animate-spin" />
                        )}
                        Áp dụng
                      </button>
                    )}
                  </div>
                  {couponError && (
                    <p className="mt-2 text-xs text-red-600">{couponError}</p>
                  )}
                  {appliedCoupon && !couponError && (
                    <p className="mt-2 text-xs text-emerald-700">
                      Đã áp dụng{" "}
                      <span className="font-mono font-semibold">
                        {appliedCoupon.code}
                      </span>
                      {appliedCoupon.discountPercent
                        ? ` (−${appliedCoupon.discountPercent}%)`
                        : ""}
                    </p>
                  )}
                </form>

                <div className="border-t border-dashed border-gray-200 mt-4 pt-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">Tổng giá tiền</p>
                    <p className="text-xl font-black text-gray-900">
                      {formatVnd(finalAmount)}
                    </p>
                    {discountAmount > 0 && (
                      <p className="text-xs text-gray-400 line-through">
                        {formatVnd(originalAmount)}
                      </p>
                    )}
                  </div>
                  <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center">
                    <FileText size={22} className="text-blue-600" />
                  </div>
                </div>
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  {errorMsg}
                </div>
              )}

              <button
                type="button"
                onClick={handleCreatePayment}
                disabled={loading}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-orange-300"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? "Đang tạo link payOS..." : "Thanh toán qua payOS"}
              </button>

              <p className="text-xs text-gray-400 text-center mt-4">
                Bằng cách tiếp tục, bạn đồng ý với{" "}
                <span className="text-blue-600 cursor-pointer hover:underline">
                  Điều khoản dịch vụ
                </span>
              </p>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default PaymentPage;
