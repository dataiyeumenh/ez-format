const nodemailer = require("nodemailer");

let transporter = null;

// Đã cấu hình SMTP đủ để gửi thật?
function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Ép IPv4: Render (và nhiều PaaS) không có route IPv6 -> nếu để mặc định,
    // smtp.gmail.com resolve ra IPv6 gây "ENETUNREACH". family:4 buộc dùng IPv4.
    family: 4,
    // Tránh treo vô hạn khi SMTP sai/bị chặn -> fail trong ~10-15s.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

function buildResetEmailHtml(resetUrl, name) {
  const greeting = name ? `Chào ${name},` : "Chào bạn,";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937">
    <h2 style="color:#2563eb;margin-bottom:8px">Đặt lại mật khẩu EzFormat</h2>
    <p>${greeting}</p>
    <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Bấm nút bên dưới để tạo mật khẩu mới:</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${resetUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block">
        Đặt lại mật khẩu
      </a>
    </p>
    <p style="font-size:13px;color:#6b7280">Liên kết này sẽ hết hạn sau 30 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.</p>
    <p style="font-size:12px;color:#9ca3af;word-break:break-all">Nếu nút không hoạt động, sao chép liên kết: ${resetUrl}</p>
  </div>`;
}

async function sendPasswordResetEmail(to, resetUrl, name = "") {
  if (!isEmailConfigured()) {
    // Dev fallback: SMTP chưa cấu hình -> log link ra console để test thủ công.
    console.warn(
      `[emailService] SMTP CHƯA cấu hình (thiếu SMTP_HOST/SMTP_USER/SMTP_PASS). ` +
        `Email KHÔNG được gửi. Reset link cho ${to}:\n${resetUrl}`,
    );
    return { sent: false, reason: "not_configured" };
  }
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  try {
    await getTransporter().sendMail({
      from,
      to,
      subject: "Đặt lại mật khẩu EzFormat",
      html: buildResetEmailHtml(resetUrl, name),
    });
    return { sent: true };
  } catch (err) {
    // Log lỗi SMTP thật để debug (sai app password, sai host/port, bị chặn...).
    console.error(`[emailService] Gửi email thất bại tới ${to}:`, err.message);
    return { sent: false, reason: "send_failed", error: err.message };
  }
}

// Kiểm tra kết nối SMTP (gọi thủ công khi debug). Trả về { ok, error }.
async function verifyEmailTransport() {
  if (!isEmailConfigured()) return { ok: false, error: "not_configured" };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isEmailConfigured, sendPasswordResetEmail, verifyEmailTransport };
