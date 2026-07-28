import { lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AuthProvider } from "./context/AuthContext";
import AdminRoute from "./components/AdminRoute";
import ProtectedRoute from "./components/ProtectedRoute";

import LandingPage from "./pages/LandingPage";
import ConvertPage from "./pages/ConvertPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import PricingPage from "./pages/PricingPage";
import ContactPage from "./pages/ContactPage";
import PaymentPage from "./pages/PaymentPage";
import PaymentResultPage from "./pages/PaymentResultPage";
import AccountingWorkspacePage from "./pages/AccountingWorkspacePage";
import { studentAssistantEnabled } from "./hooks/useStudentAssistantApi";

const AdminDashboard = lazy(() => import("./pages/admin/DashboardPage"));
const UsersPage = lazy(() => import("./pages/admin/UsersPage"));
const FilesPage = lazy(() => import("./pages/admin/FilesPage"));
const PlansPage = lazy(() => import("./pages/admin/PlansPage"));
const RevenuePage = lazy(() => import("./pages/admin/RevenuePage"));
const LogsPage = lazy(() => import("./pages/admin/LogsPage"));
const StudentAssistantPage = lazy(() => import("./pages/StudentAssistantPage"));

function PageLoader() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <Loader2 className="animate-spin text-primary-500" size={32} />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route
            path="/convert"
            element={
              <ProtectedRoute>
                <ConvertPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/workspaces"
            element={
              <ProtectedRoute>
                <AccountingWorkspacePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student"
            element={
              studentAssistantEnabled ? (
                <ProtectedRoute>
                  <Suspense fallback={<PageLoader />}>
                    <StudentAssistantPage />
                  </Suspense>
                </ProtectedRoute>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/payment" element={<PaymentPage />} />
          <Route
            path="/payment/success"
            element={<PaymentResultPage status="success" />}
          />
          <Route
            path="/payment/cancel"
            element={<PaymentResultPage status="cancel" />}
          />

          {/* Admin routes */}
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <AdminDashboard />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/dashboard"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <AdminDashboard />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <UsersPage />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/files"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <FilesPage />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/plans"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <PlansPage />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/revenue"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <RevenuePage />
                </Suspense>
              </AdminRoute>
            }
          />
          <Route
            path="/admin/logs"
            element={
              <AdminRoute>
                <Suspense fallback={<PageLoader />}>
                  <LogsPage />
                </Suspense>
              </AdminRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
