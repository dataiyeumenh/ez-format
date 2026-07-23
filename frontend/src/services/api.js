import axios from "axios";

// In dev: Vite proxy forwards Node API /api → localhost:5000
// In production: set VITE_NODE_API_URL to the Node backend URL.
// VITE_API_URL is kept as a backwards-compatible alias for older Vercel envs.
const configuredBaseURL =
  import.meta.env.VITE_NODE_API_URL || import.meta.env.VITE_API_URL;
const baseURL = configuredBaseURL
  ? `${String(configuredBaseURL).replace(/\/+$/, "")}/api`
  : "/api";

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
