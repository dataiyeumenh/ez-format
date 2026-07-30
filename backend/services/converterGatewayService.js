const MAX_UPSTREAM_ERROR_BODY_BYTES = 128 * 1024;
const SERVICE_TOKEN_PLACEHOLDER = "replace-with-a-long-random-secret";
const MIN_SERVICE_TOKEN_CHARS = 32;
const SAFE_RESPONSE_HEADERS = new Set(["content-disposition", "content-type", "retry-after"]);
const PROTECTED_HEADERS = new Set(["content-type", "x-conversion-context", "x-converter-service-token", "x-request-id"]);

function gatewayError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function isConverterGatewayUsageReady(env = process.env) {
  return String(env.CONVERTER_PUBLIC_PROXY_ENABLED || "false").trim().toLowerCase() === "true" &&
    String(env.CONVERTER_GATEWAY_USAGE_READY || "false").trim().toLowerCase() === "true";
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && Number(parts[0]) === 127;
}

function validateInterServiceUrl(value, env = process.env) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch (cause) {
    throw gatewayError(503, "Converter internal URL is invalid", "INVALID_CONVERTER_URL");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !["http:", "https:"].includes(parsed.protocol)) {
    throw gatewayError(503, "Converter internal URL is invalid", "INVALID_CONVERTER_URL");
  }
  if (parsed.protocol === "https:") return String(value).trim().replace(/\/+$/, "");
  const localAllowed = ["development", "test"].includes(String(env.NODE_ENV || "").toLowerCase()) &&
    ["1", "true", "yes"].includes(String(env.CONVERTER_ALLOW_INSECURE_LOCALHOST || "").toLowerCase());
  if (!isLoopbackHostname(parsed.hostname) || !localAllowed) throw gatewayError(503, "Converter internal URL must use HTTPS outside localhost", "INSECURE_CONVERTER_URL");
  return String(value).trim().replace(/\/+$/, "");
}

function assertConverterGatewayStartupConfig(env = process.env) {
  if (!isConverterGatewayUsageReady(env)) return true;
  const contextSecret = String(env.CONVERSION_CONTEXT_SECRET || "").trim();
  if (contextSecret.length < 32) throw gatewayError(503, "CONVERSION_CONTEXT_SECRET must be at least 32 characters", "MISSING_CONVERSION_CONTEXT_SECRET");
  const serviceToken = String(env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!serviceToken) throw gatewayError(503, "CONVERTER_SERVICE_TOKEN is required", "MISSING_CONVERTER_SERVICE_TOKEN");
  if (serviceToken.length < MIN_SERVICE_TOKEN_CHARS || serviceToken === SERVICE_TOKEN_PLACEHOLDER || serviceToken.toLowerCase().startsWith("replace-with-")) throw gatewayError(503, "CONVERTER_SERVICE_TOKEN must be at least 32 characters and not a placeholder", "WEAK_CONVERTER_SERVICE_TOKEN");
  const internalUrl = String(env.CONVERTER_INTERNAL_URL || "").trim();
  if (!internalUrl) throw gatewayError(503, "CONVERTER_INTERNAL_URL is required", "MISSING_CONVERTER_INTERNAL_URL");
  validateInterServiceUrl(internalUrl, env);
  if (String(env.CONVERTER_ARTIFACT_STORAGE_DRIVER || "").trim().toLowerCase() !== "mongodb") throw gatewayError(503, "MongoDB/GridFS artifact storage is required", "GRIDFS_CONFIG_MISSING");
  if (!String(env.CONVERTER_MONGODB_GRIDFS_BUCKET || "").trim() || !String(env.MONGO_URI || "").trim()) throw gatewayError(503, "MongoDB/GridFS artifact storage is not configured", "GRIDFS_CONFIG_MISSING");
  return true;
}

function converterBaseUrl(env = process.env) {
  return validateInterServiceUrl(env.CONVERTER_INTERNAL_URL, env);
}

function internalHeaders({ contextToken, requestId, contentType, extraHeaders = {}, requireContext = true } = {}) {
  const serviceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!serviceToken) throw gatewayError(503, "Converter service token is missing", "MISSING_CONVERTER_SERVICE_TOKEN");
  const context = String(contextToken || "").trim();
  if (requireContext && !context) throw gatewayError(401, "Conversion context is required", "MISSING_CONVERSION_CONTEXT");
  const request = String(requestId || "").trim().slice(0, 128);
  if (!request) throw gatewayError(400, "Request ID is required", "MISSING_REQUEST_ID");
  const headers = { "x-converter-service-token": serviceToken, "x-request-id": request };
  if (context) headers["x-conversion-context"] = context;
  if (contentType) headers["content-type"] = contentType;
  for (const [name, value] of Object.entries(extraHeaders)) {
    const normalized = String(name).toLowerCase();
    if (normalized && !PROTECTED_HEADERS.has(normalized) && String(value).trim()) headers[normalized] = String(value).trim();
  }
  return headers;
}

async function readBounded(response, maxBytes, binary) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw gatewayError(413, "Converter response exceeds the size limit", "UPSTREAM_BODY_TOO_LARGE");
    return binary ? buffer : buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) { await reader.cancel(); throw gatewayError(413, "Converter response exceeds the size limit", "UPSTREAM_BODY_TOO_LARGE"); }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const buffer = Buffer.concat(chunks, total);
  return binary ? buffer : buffer.toString("utf8");
}

async function fetchConverter(path, options, binary = false) {
  if (!String(path || "").startsWith("/")) throw gatewayError(500, "Converter path is invalid", "INVALID_CONVERTER_PATH");
  let response;
  try { response = await fetch(`${converterBaseUrl()}${path}`, { ...options, signal: AbortSignal.timeout(Number(process.env.CONVERTER_TIMEOUT_MS || 120000)) }); }
  catch (error) { if (error?.name === "TimeoutError" || error?.name === "AbortError") throw gatewayError(504, "Converter timed out", "CONVERTER_TIMEOUT"); throw gatewayError(502, "Cannot connect to converter", "CONVERTER_UNREACHABLE"); }
  const headers = {};
  for (const [name, value] of response.headers.entries()) if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  const payload = await readBounded(response, binary ? Number(process.env.CONVERTER_MAX_OUTPUT_BYTES || 64 * 1024 * 1024) : MAX_UPSTREAM_ERROR_BODY_BYTES, binary);
  if (binary) return { status: response.status, headers, data: payload };
  let data = null;
  if (payload) { try { data = JSON.parse(payload); } catch { throw gatewayError(502, "Converter returned invalid JSON", "INVALID_UPSTREAM_RESPONSE"); } }
  return { status: response.status, headers, data };
}

function forwardJson({ path, method = "POST", body, contextToken, requestId, extraHeaders, requireContext = true } = {}) {
  const normalizedMethod = String(method).toUpperCase();
  return fetchConverter(path, { method: normalizedMethod, headers: internalHeaders({ contextToken, requestId, contentType: normalizedMethod === "GET" ? undefined : "application/json", extraHeaders, requireContext }), body: ["GET", "HEAD"].includes(normalizedMethod) ? undefined : JSON.stringify(body || {}) });
}

function forwardMultipart({ path, file, fields = {}, contextToken, requestId, extraHeaders } = {}) {
  if (!file?.buffer) throw gatewayError(400, "Excel file is required", "MISSING_FILE");
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value != null && value !== "") form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  form.append("file", new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }), file.originalname);
  return fetchConverter(path, { method: "POST", headers: internalHeaders({ contextToken, requestId, extraHeaders }), body: form });
}

function forwardBinary({ path, body, contextToken, requestId, extraHeaders, method = "POST" } = {}) {
  return fetchConverter(path, { method, headers: internalHeaders({ contextToken, requestId, contentType: "application/json", extraHeaders }), body: JSON.stringify(body || {}) }, true);
}

function isConverterTimeoutError(error) {
  return Number(error?.statusCode) === 504 ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.code === "UND_ERR_CONNECT_TIMEOUT";
}

module.exports = { assertConverterGatewayStartupConfig, converterBaseUrl, forwardBinary, forwardJson, forwardMultipart, internalHeaders, isConverterGatewayUsageReady, isConverterTimeoutError, validateInterServiceUrl };
