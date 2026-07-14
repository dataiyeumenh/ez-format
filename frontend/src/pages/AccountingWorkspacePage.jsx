import { useState } from "react";
import { Building2, Database, ShieldCheck } from "lucide-react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import WorkspaceSelector from "../components/accounting/WorkspaceSelector";
import WorkspaceSetupModal from "../components/accounting/WorkspaceSetupModal";
import MasterDataManager from "../components/accounting/MasterDataManager";
import { useAccountingWorkspaces } from "../hooks/useAccountingWorkspaces";

export default function AccountingWorkspacePage() {
  const [setupOpen, setSetupOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const {
    enabled,
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    snapshots,
    loading,
    masterDataLoading,
    error,
    createWorkspace,
    importCatalog,
    activateSnapshot,
  } = useAccountingWorkspaces();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-emerald-50/40">
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-800">
            <ShieldCheck size={16} /> Dữ liệu tách riêng theo doanh nghiệp
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
            Hồ sơ doanh nghiệp và danh mục MISA
          </h1>
          <p className="mt-3 text-base leading-7 text-gray-600">
            Chọn đúng doanh nghiệp trước khi chuyển đổi để EzFormat kiểm tra mã nhà cung
            cấp, hàng hóa, kho, đơn vị tính và tài khoản theo danh mục đang dùng trên
            MISA.
          </p>
        </div>

        {!enabled ? (
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
            Tính năng hồ sơ doanh nghiệp đang được tắt bằng cấu hình triển khai.
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <WorkspaceSelector
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              selectedWorkspace={selectedWorkspace}
              loading={loading}
              onSelect={setSelectedWorkspaceId}
              onCreate={() => setSetupOpen(true)}
              onManage={() => setManagerOpen(true)}
            />

            <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-card">
              {error && (
                <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              {selectedWorkspace ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-emerald-700">
                        <Building2 size={20} />
                        <span className="text-sm font-bold">Hồ sơ đang chọn</span>
                      </div>
                      <h2 className="mt-2 text-2xl font-black text-gray-950">
                        {selectedWorkspace.name}
                      </h2>
                      <p className="mt-1 text-sm text-gray-500">
                        MST: {selectedWorkspace.taxCode || "Chưa khai báo"} · MISA{" "}
                        {selectedWorkspace.misaProduct}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setManagerOpen(true)}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-primary-700"
                    >
                      <Database size={17} /> Quản lý danh mục
                    </button>
                  </div>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-sm text-gray-500">Danh mục đang hoạt động</p>
                      <p className="mt-1 text-2xl font-black text-gray-950">
                        {selectedWorkspace.activeSnapshots?.length || 0}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-sm text-gray-500">Các phiên bản đã tải</p>
                      <p className="mt-1 text-2xl font-black text-gray-950">
                        {masterDataLoading ? "…" : snapshots.length}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center text-center">
                  <Building2 size={38} className="text-gray-300" />
                  <h2 className="mt-3 text-lg font-black text-gray-900">
                    Chưa chọn doanh nghiệp
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-gray-500">
                    Tạo hồ sơ đầu tiên hoặc chọn một doanh nghiệp để quản lý danh mục
                    MISA.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
      <Footer />

      <WorkspaceSetupModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onCreate={createWorkspace}
      />
      <MasterDataManager
        open={managerOpen}
        workspace={selectedWorkspace}
        snapshots={snapshots}
        onClose={() => setManagerOpen(false)}
        onImport={(type, file) => importCatalog(selectedWorkspaceId, type, file)}
        onActivate={(snapshotId) => activateSnapshot(selectedWorkspaceId, snapshotId)}
      />
    </div>
  );
}
