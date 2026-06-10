const { OAuth2Client } = require("google-auth-library");

let client;

const getClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    const error = new Error("GOOGLE_CLIENT_ID chưa được cấu hình");
    error.statusCode = 500;
    throw error;
  }

  if (!client) {
    client = new OAuth2Client(clientId);
  }
  return { client, clientId };
};

const verifyGoogleCredential = async (credential) => {
  if (!credential || typeof credential !== "string") {
    const error = new Error("Thiếu Google credential");
    error.statusCode = 400;
    throw error;
  }

  const { client: oauthClient, clientId } = getClient();
  const ticket = await oauthClient.verifyIdToken({
    idToken: credential,
    audience: clientId,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload?.email) {
    const error = new Error("Google credential không hợp lệ");
    error.statusCode = 401;
    throw error;
  }

  if (payload.email_verified !== true) {
    const error = new Error("Email Google chưa được xác minh");
    error.statusCode = 401;
    throw error;
  }

  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase(),
    name: payload.name || payload.email,
    avatar: payload.picture || "",
  };
};

module.exports = { verifyGoogleCredential };
