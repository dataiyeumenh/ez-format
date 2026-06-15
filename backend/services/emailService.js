// Gửi email qua SendGrid HTTP API (https, port 443) thay vì SMTP —
// vì Render chặn outbound SMTP (port 25/465/587).
const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

function isEmailConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDER_EMAIL);
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

// fetch kèm timeout để không treo nếu SendGrid chậm.
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendPasswordResetEmail(to, resetUrl, name = "") {
  if (!isEmailConfigured()) {
    console.warn(
      `[emailService] SendGrid CHƯA cấu hình (thiếu SENDGRID_API_KEY/SENDER_EMAIL). ` +
        `Email KHÔNG được gửi. Reset link cho ${to}:\n${resetUrl}`,
    );
    return { sent: false, reason: "not_configured" };
  }

  try {
    const res = await fetchWithTimeout(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: {
          email: process.env.SENDER_EMAIL,
          name: process.env.SENDER_NAME || "EzFormat",
        },
        subject: "Đặt lại mật khẩu EzFormat",
        content: [{ type: "text/html", value: buildResetEmailHtml(resetUrl, name) }],
      }),
    });

    // SendGrid trả 202 Accepted khi nhận thành công.
    if (res.status !== 202) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[emailService] SendGrid trả lỗi ${res.status} khi gửi tới ${to}: ${detail}`,
      );
      return { sent: false, reason: "send_failed", status: res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[emailService] Gửi email thất bại tới ${to}:`, err.message);
    return { sent: false, reason: "send_failed", error: err.message };
  }
}

// Kiểm tra API key SendGrid (gọi thủ công khi debug). Trả về { ok, error }.
async function verifyEmailTransport() {
  if (!isEmailConfigured()) return { ok: false, error: "not_configured" };
  try {
    const res = await fetchWithTimeout("https://api.sendgrid.com/v3/scopes", {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isEmailConfigured, sendPasswordResetEmail, verifyEmailTransport };
