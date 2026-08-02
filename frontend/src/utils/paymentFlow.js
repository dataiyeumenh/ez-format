export function resolvePaymentNavigation(paymentResponse = {}) {
  if (paymentResponse.freeCheckout) {
    if (!paymentResponse.orderCode) {
      throw new Error("Backend không trả orderCode cho giao dịch 0đ.");
    }
    const params = new URLSearchParams({
      orderCode: String(paymentResponse.orderCode),
      settled: "1",
    });
    return {
      mode: "internal",
      href: `/payment/success?${params.toString()}`,
    };
  }

  if (!paymentResponse.checkoutUrl) {
    throw new Error("Backend không trả checkoutUrl.");
  }
  return { mode: "external", href: paymentResponse.checkoutUrl };
}

export function hasPaidBenefit(user) {
  const planCode =
    typeof user?.plan === "object" ? user.plan?.code : user?.plan;
  const normalizedPlanCode = String(planCode || "").toLowerCase();
  return (
    normalizedPlanCode === "monthly" ||
    normalizedPlanCode === "yearly" ||
    Number(user?.fileCredits || 0) > 0
  );
}
