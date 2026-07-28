import axios from "axios";

// In dev: Vite proxy forwards Node API /api → localhost:5000
// In production: VITE_API_URL points at the authenticated Node API.
// VITE_NODE_API_URL remains a backwards-compatible fallback.
const viteEnv = import.meta.env || {};
const configuredBaseURL = viteEnv.VITE_API_URL || viteEnv.VITE_NODE_API_URL;

export function normalizeApiBaseURL(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) return "/api";
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

const baseURL = normalizeApiBaseURL(configuredBaseURL);

// Let Axios select the content type from each payload. A global JSON header
// serializes FormData uploads as JSON and strips the attached Excel file.
const api = axios.create({ baseURL });

export function shouldLogoutForUnauthorized(error) {
  if (error.response?.status !== 401) return false;
  const requestUrl = String(error.config?.url || "");
  const isAuthAttempt =
    requestUrl.includes("/auth/login") ||
    requestUrl.includes("/auth/register") ||
    requestUrl.includes("/auth/google");
  const canRefreshConverterContext =
    requestUrl.includes("/converter/conversions/export") &&
    error.config?.allowConverterContextRefresh === true;
  return !isAuthAttempt && !canRefreshConverterContext;
}

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (shouldLogoutForUnauthorized(error)) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export default api;
