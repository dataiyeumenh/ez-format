import axios from "axios";

// Leave unset in development to use Vite's authenticated Node API proxy.
// Browser traffic never targets the converter service directly.
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
    const requestUrl = String(error.config?.url || "");
    const isAuthAttempt =
      requestUrl.includes("/auth/login") ||
      requestUrl.includes("/auth/register") ||
      requestUrl.includes("/auth/google");
    if (error.response?.status === 401 && !isAuthAttempt) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export default api;
