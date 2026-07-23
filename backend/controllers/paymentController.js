const Payment = require("../models/Payment");
const User = require("../models/User");
const { getPayOSClient } = require("../services/payosClient");
const { buildPaymentDescription } = require("../services/paymentPlans");
const { findActivePlanByCodeOrId, serializePlan } = require("../services/planService");
const { applyPaidPlanToUser } = require("../services/subscriptionService");
const {
  normalizePayOSStatus,
  syncPaymentStatusFromPayOS,
} = require("../services/paymentStatusSync");
const {
  validateCouponForCheckout,
  recordCouponUsage,
  normalizeCouponCode,
} = require("../services/couponService");

function getReturnUrl() {
  return (
    process.env.PAYOS_RETURN_URL ||
    `${process.env.FRONTEND_URL || "http://localhost:5173"}/payment/success`
  );
}

function getCancelUrl() {
  return (
    process.env.PAYOS_CANCEL_URL ||
    `${process.env.FRONTEND_URL || "http://localhost:5173"}/payment/cancel`
  );
}

async function generateOrderCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const base = Date.now() % 1_000_000_000;
    const random = Math.floor(Math.random() * 1000);
    const orderCode = base * 1000 + random;
    // eslint-disable-next-line no-await-in-loop
    const exists = await Payment.exists({ orderCode });
    if (!exists) return orderCode;
  }
  throw new Error("Không thể tạo mã đơn hàng duy nhất");
}

function serializePayment(payment) {
  return {
    id: payment._id,
    orderCode: payment.orderCode,
    plan: payment.plan ? serializePlan(payment.plan) : null,
    planCode: payment.planCode,
    planName: payment.planName,
    amount: payment.amount,
    originalAmount: payment.originalAmount ?? payment.amount,
    discountAmount: payment.discountAmount || 0,
    couponCode: payment.couponCode || "",
    couponApplied: Boolean(payment.couponApplied),
    status: payment.status,
    checkoutUrl: payment.checkoutUrl,
    paymentLinkId: payment.paymentLinkId,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
  };
}

async function previewCoupon(req, res) {
  try {
    const planIdentifier = req.body?.planId || req.body?.planCode || req.body?.planType;
    const plan = await findActivePlanByCodeOrId(planIdentifier);
    if (!plan || plan.price <= 0 || plan.code === "free") {
      return res.status(400).json({
        success: false,
        message: "Gói thanh toán không hợp lệ",
      });
    }

    const { coupon, pricing, serialized } = await validateCouponForCheckout({
      couponCode: req.body?.couponCode,
      plan,
      userId: req.user._id,
    });

    return res.json({
      success: true,
      coupon: {
        code: serialized.code,
        description: serialized.description,
        discountPercent: serialized.discountPercent,
        maxDiscountAmount: serialized.maxDiscountAmount,
      },
      originalAmount: pricing.originalAmount,
      discountAmount: pricing.discountAmount,
      finalAmount: pricing.finalAmount,
      couponId: String(coupon._id),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Không thể áp dụng mã giảm giá",
    });
  }
}

async function createPayment(req, res) {
  const planIdentifier = req.body?.planId || req.body?.planCode || req.body?.planType;
  const plan = await findActivePlanByCodeOrId(planIdentifier);

  if (!plan || plan.price <= 0 || plan.code === "free") {
    return res.status(400).json({
      success: false,
      message: "Gói thanh toán không hợp lệ",
    });
  }

  try {
    let originalAmount = plan.price;
    let discountAmount = 0;
    let finalAmount = plan.price;
    let couponDoc = null;
    let couponCode = "";

    const rawCouponCode = String(req.body?.couponCode || "").trim();
    if (rawCouponCode) {
      const validated = await validateCouponForCheckout({
        couponCode: rawCouponCode,
        plan,
        userId: req.user._id,
      });
      couponDoc = validated.coupon;
      couponCode = normalizeCouponCode(rawCouponCode);
      originalAmount = validated.pricing.originalAmount;
      discountAmount = validated.pricing.discountAmount;
      finalAmount = validated.pricing.finalAmount;
    }

    // payOS thường yêu cầu số tiền tối thiểu 1000 VND
    if (finalAmount > 0 && finalAmount < 1000) {
      return res.status(400).json({
        success: false,
        message:
          "Số tiền sau giảm giá thấp hơn mức tối thiểu 1.000 VND. Vui lòng chọn mã khác.",
      });
    }

    const orderCode = await generateOrderCode();
    const payment = await Payment.create({
      user: req.user._id,
      plan: plan._id,
      orderCode,
      planCode: plan.code,
      planName: plan.name,
      amount: finalAmount,
      originalAmount,
      discountAmount,
      coupon: couponDoc ? couponDoc._id : null,
      couponCode,
      couponApplied: Boolean(couponDoc),
      status: "pending",
    });

    // Giảm 100% => kích hoạt gói ngay, không qua payOS
    if (finalAmount === 0) {
      const user = await User.findById(req.user._id);
      if (!user) {
        payment.status = "failed";
        await payment.save();
        return res.status(400).json({
          success: false,
          message: "Không tìm thấy tài khoản người dùng",
        });
      }
      const paidAt = new Date();
      applyPaidPlanToUser(user, plan, paidAt);
      await user.save();
      payment.status = "paid";
      payment.paidAt = paidAt;
      await payment.save();
      if (couponDoc) {
        await recordCouponUsage({
          couponId: couponDoc._id,
          userId: user._id,
          paymentId: payment._id,
          discountAmount,
        });
      }
      return res.status(201).json({
        success: true,
        payment: serializePayment(payment),
        checkoutUrl: getReturnUrl(),
        orderCode,
        freeCheckout: true,
      });
    }

    const payOS = getPayOSClient();
    const paymentLink = await payOS.paymentRequests.create({
      orderCode,
      amount: finalAmount,
      description: buildPaymentDescription(plan.code),
      items: [
        {
          name: plan.name,
          quantity: 1,
          price: finalAmount,
        },
      ],
      buyerName: req.user.name,
      buyerEmail: req.user.email,
      returnUrl: getReturnUrl(),
      cancelUrl: getCancelUrl(),
    });

    payment.checkoutUrl = paymentLink.checkoutUrl;
    payment.paymentLinkId = paymentLink.paymentLinkId;
    payment.payosData = paymentLink;
    await payment.save();

    return res.status(201).json({
      success: true,
      payment: serializePayment(payment),
      checkoutUrl: payment.checkoutUrl,
      orderCode,
    });
  } catch (error) {
    const isCouponError =
      /mã giảm giá|coupon|áp dụng/i.test(String(error.message || "")) ||
      error.message?.includes("Mã");
    return res.status(isCouponError ? 400 : 500).json({
      success: false,
      message: isCouponError
        ? error.message
        : "Không thể tạo link thanh toán",
      error: error.message,
    });
  }
}

async function getPayment(req, res) {
  try {
    const payment = await Payment.findOne({
      orderCode: Number(req.params.orderCode),
      user: req.user._id,
    }).populate("plan");

    if (!payment) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy đơn thanh toán" });
    }

    const syncedPayment = await syncPaymentStatusFromPayOS(payment).catch(() => payment);
    return res.json({ success: true, payment: serializePayment(syncedPayment) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể lấy thông tin thanh toán",
      error: error.message,
    });
  }
}

async function syncPayment(req, res) {
  try {
    const payment = await Payment.findOne({
      orderCode: Number(req.params.orderCode),
    }).populate("plan");

    if (!payment) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy đơn thanh toán" });
    }

    const syncedPayment = await syncPaymentStatusFromPayOS(payment);
    return res.json({
      success: true,
      payment: {
        orderCode: syncedPayment.orderCode,
        status: syncedPayment.status,
        paidAt: syncedPayment.paidAt,
        updatedAt: syncedPayment.updatedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể đồng bộ trạng thái thanh toán",
      error: error.message,
    });
  }
}

async function handlePayOSWebhook(req, res) {
  try {
    const payOS = getPayOSClient();
    const webhookData = await payOS.webhooks.verify(req.body);
    const webhookStatus =
      webhookData?.status || webhookData?.data?.status || req.body?.data?.status;
    const webhookMappedStatus = normalizePayOSStatus(webhookStatus);
    const isPaid =
      req.body?.success === true ||
      webhookData?.code === "00" ||
      webhookMappedStatus === "paid";

    const payment = await Payment.findOne({ orderCode: webhookData.orderCode }).populate("plan");
    if (!payment) {
      return res.status(200).json({ success: true, message: "Payment ignored" });
    }

    if (payment.status === "paid") {
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    payment.payosData = {
      ...(payment.payosData || {}),
      webhook: req.body,
      verifiedData: webhookData,
    };

    if (
      Number(webhookData.amount) !== Number(payment.amount) ||
      (payment.paymentLinkId &&
        webhookData.paymentLinkId &&
        webhookData.paymentLinkId !== payment.paymentLinkId)
    ) {
      payment.status = "failed";
      await payment.save();
      return res.status(200).json({
        success: true,
        message: "Webhook mismatch ignored",
      });
    }

    if (!isPaid) {
      try {
        await syncPaymentStatusFromPayOS(payment);
      } catch {
        payment.status = webhookMappedStatus === "pending" ? "failed" : webhookMappedStatus;
        await payment.save();
      }
      await payment.save();
      return res.status(200).json({ success: true });
    }

    const user = await User.findById(payment.user);
    if (!user) {
      payment.status = "failed";
      await payment.save();
      return res.status(200).json({ success: true, message: "User missing" });
    }

    const paidAt = new Date();
    applyPaidPlanToUser(user, payment.plan, paidAt);
    await user.save();

    payment.status = "paid";
    payment.paidAt = paidAt;
    await payment.save();

    if (payment.coupon && !payment.couponApplied) {
      // legacy safety
    }
    if (payment.coupon) {
      const already = await require("../models/CouponUsage").exists({
        payment: payment._id,
      });
      if (!already) {
        await recordCouponUsage({
          couponId: payment.coupon,
          userId: user._id,
          paymentId: payment._id,
          discountAmount: payment.discountAmount || 0,
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "Webhook payOS không hợp lệ",
      error: error.message,
    });
  }
}

module.exports = {
  createPayment,
  previewCoupon,
  getPayment,
  handlePayOSWebhook,
  syncPayment,
  generateOrderCode,
};
