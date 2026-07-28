const SENSITIVE_UPSTREAM_KEYS = new Set([
  "authorization",
  "auth",
  "authentication",
  "auth-header",
  "auth-token",
  "body",
  "cookie",
  "headers",
  "input",
  "password",
  "raw",
  "secret",
  "stack",
  "token",
  "traceback",
  "service-token",
  "service_token",
  "x-conversion-context",
  "x-converter-service-token",
  "x-reconstruction-context",
  "x-student-context",
]);
const PROTECTED_INTERNAL_HEADERS = new Set([
  "content-type",
  "x-conversion-context",
  "x-converter-service-token",
  "x-request-id",
]);
const SAFE_UPSTREAM_RESPONSE_HEADERS = new Set([
  "content-disposition",
  "content-type",
  "retry-after",
]);
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_UPSTREAM_ERROR_BODY_BYTES = 128 * 1024;
const UPSTREAM_JSON_LIMITS = Object.freeze({
  maxArrayItems: 100,
  maxDepth: 8,
  maxNodes: 500,
  maxObjectKeys: 100,
  maxStringChars: 4096,
  totalStringChars: 60000,
});

function converterBaseUrl() {
  return String(
    process.env.CONVERTER_INTERNAL_URL ||
      process.env.PYTHON_API_URL ||
      process.env.CONVERTER_URL ||
      "http://127.0.0.1:8000",
  ).replace(/\/+$/, "");
}

function converterTimeoutMs() {
  const configured = Number(process.env.CONVERTER_TIMEOUT_MS || 120000);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

function gatewayError(statusCode, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  return error;
}

function internalHeaders({ contextToken, requestId, contentType, extraHeaders = {} }) {
  const serviceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!serviceToken) {
    throw gatewayError(503, "Thiếu Converter service token");
  }
  const normalizedContext = String(contextToken || "").trim();
  if (!normalizedContext) {
    throw gatewayError(503, "Thiếu conversion context");
  }
  const normalizedRequestId = String(requestId || "").trim().slice(0, 128);
  if (!normalizedRequestId) {
    throw gatewayError(503, "Thiếu request ID nội bộ");
  }
  const headers = {
    "x-converter-service-token": serviceToken,
    "x-request-id": normalizedRequestId,
    "x-conversion-context": normalizedContext,
  };
  if (contentType) headers["content-type"] = contentType;
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    const normalizedName = String(name || "").trim().toLowerCase();
    const normalizedValue = String(value || "").trim();
    if (
      normalizedName &&
      normalizedValue &&
      !PROTECTED_INTERNAL_HEADERS.has(normalizedName)
    ) {
      headers[normalizedName] = normalizedValue;
    }
  }
  return headers;
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (SAFE_UPSTREAM_RESPONSE_HEADERS.has(normalizedName)) {
      headers[normalizedName] = value;
    }
  }
  return headers;
}

function isSensitiveUpstreamKey(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_UPSTREAM_KEYS.has(String(key || "").trim().toLowerCase()) ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.endsWith("token")
  );
}

function redactSensitiveString(value) {
  return String(value).replace(
    /(\b(?:token|secret|password|authorization|api[-_ ]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|bearer\s+[^\s,;&}\]]+|[^\s,;&}\]]+)/gi,
    `$1${REDACTED}`,
  );
}

function sanitizeUpstreamValue(value, depth, state) {
  if (depth >= UPSTREAM_JSON_LIMITS.maxDepth) return TRUNCATED;
  state.nodes += 1;
  if (state.nodes > UPSTREAM_JSON_LIMITS.maxNodes) return TRUNCATED;
  if (typeof value === "string") {
    if (state.remainingChars <= 0) return TRUNCATED;
    const redacted = redactSensitiveString(value);
    const available = Math.min(
      UPSTREAM_JSON_LIMITS.maxStringChars,
      state.remainingChars,
    );
    const sanitized = redacted.length > available
      ? `${redacted.slice(0, Math.max(0, available - TRUNCATED.length))}${TRUNCATED}`
      : redacted;
    state.remainingChars -= sanitized.length;
    return sanitized;
  }
  if (Array.isArray(value)) {
    const hasMore = value.length > UPSTREAM_JSON_LIMITS.maxArrayItems;
    const itemLimit = hasMore
      ? UPSTREAM_JSON_LIMITS.maxArrayItems - 1
      : UPSTREAM_JSON_LIMITS.maxArrayItems;
    const items = value
      .slice(0, itemLimit)
      .map((item) => sanitizeUpstreamValue(item, depth + 1, state));
    if (hasMore) items.push(TRUNCATED);
    return items;
  }
  if (!value || typeof value !== "object") return value;
  const entries = [];
  for (const [key, item] of Object.entries(value).slice(
    0,
    UPSTREAM_JSON_LIMITS.maxObjectKeys,
  )) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    const safeKey = redactSensitiveString(key).slice(0, 128);
    entries.push([
      safeKey,
      isSensitiveUpstreamKey(key)
        ? REDACTED
        : sanitizeUpstreamValue(item, depth + 1, state),
    ]);
  }
  return Object.fromEntries(entries);
}

function sanitizeUpstreamJson(value) {
  return sanitizeUpstreamValue(value, 0, {
    nodes: 0,
    remainingChars: UPSTREAM_JSON_LIMITS.totalStringChars,
  });
}

async function readBoundedResponseText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    const error = gatewayError(502, "Converter trả về phản hồi quá lớn");
    error.code = "UPSTREAM_BODY_TOO_LARGE";
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        const error = gatewayError(502, "Converter trả về phản hồi quá lớn");
        error.code = "UPSTREAM_BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readJsonPayload(response, sanitize = false) {
  const text = sanitize
    ? await readBoundedResponseText(response, MAX_UPSTREAM_ERROR_BODY_BYTES)
    : await response.text();
  if (!text) return null;
  try {
    const payload = JSON.parse(text);
    return sanitize ? sanitizeUpstreamJson(payload) : payload;
  } catch {
    throw gatewayError(502, "Converter trả về phản hồi không hợp lệ");
  }
}

async function fetchConverter(path, options, binary = false) {
  const normalizedPath = String(path || "").trim();
  if (!normalizedPath.startsWith("/")) {
    throw gatewayError(500, "Converter path không hợp lệ");
  }
  const signal = AbortSignal.timeout(converterTimeoutMs());
  try {
    const response = await fetch(`${converterBaseUrl()}${normalizedPath}`, {
      ...options,
      signal,
    });
    const headers = responseHeaders(response);
    const isJson = String(headers["content-type"] || "")
      .toLowerCase()
      .includes("application/json");

    if (!response.ok) {
      let data;
      if (!isJson) {
        void response.body?.cancel().catch(() => {});
        data = {
          success: false,
          message:
            response.status >= 500
              ? "Converter không thể xử lý yêu cầu"
              : "Converter từ chối yêu cầu",
        };
      } else {
        try {
          data = await readJsonPayload(response, true);
        } catch (error) {
          if (error?.statusCode !== 502) throw error;
          data = {
            success: false,
            message:
              error.code === "UPSTREAM_BODY_TOO_LARGE"
                ? "Converter trả về phản hồi quá lớn"
                : "Converter trả về phản hồi không hợp lệ",
          };
        }
      }
      headers["content-type"] = "application/json";
      return { status: response.status, headers, data };
    }
    if (binary && !isJson) {
      const data = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers, data };
    }
    if (!isJson && response.status !== 204) {
      void response.body?.cancel().catch(() => {});
      throw gatewayError(502, "Converter trả về phản hồi không hợp lệ");
    }
    const data = response.status === 204 ? null : await readJsonPayload(response);
    return { status: response.status, headers, data };
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw gatewayError(504, "Converter phản hồi quá thời gian", error);
    }
    throw gatewayError(502, "Không thể kết nối Converter", error);
  }
}

async function forwardJson({
  path,
  method = "POST",
  body,
  contextToken,
  requestId,
  extraHeaders,
}) {
  const normalizedMethod = String(method || "POST").toUpperCase();
  const headers = internalHeaders({
    contextToken,
    requestId,
    contentType: normalizedMethod === "GET" ? undefined : "application/json",
    extraHeaders,
  });
  return fetchConverter(path, {
    method: normalizedMethod,
    headers,
    body:
      normalizedMethod === "GET" || normalizedMethod === "HEAD"
        ? undefined
        : JSON.stringify(body || {}),
  });
}

async function forwardMultipart({
  path,
  file,
  fields = {},
  contextToken,
  requestId,
  extraHeaders,
}) {
  if (!file?.buffer) throw gatewayError(400, "Thiếu file Excel");
  const form = new FormData();
  for (const [name, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  form.append(
    "file",
    new Blob([file.buffer], {
      type: file.mimetype || "application/octet-stream",
    }),
    file.originalname,
  );
  return fetchConverter(path, {
    method: "POST",
    headers: internalHeaders({ contextToken, requestId, extraHeaders }),
    body: form,
  });
}

async function forwardBinary({
  path,
  body,
  contextToken,
  requestId,
  extraHeaders,
  method = "POST",
}) {
  return fetchConverter(
    path,
    {
      method,
      headers: internalHeaders({
        contextToken,
        requestId,
        contentType: "application/json",
        extraHeaders,
      }),
      body: JSON.stringify(body || {}),
    },
    true,
  );
}

module.exports = {
  converterBaseUrl,
  forwardBinary,
  forwardJson,
  forwardMultipart,
  internalHeaders,
  sanitizeUpstreamJson,
};
