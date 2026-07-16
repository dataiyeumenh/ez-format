import { Building2, Database, Plus } from "lucide-react";

export default function WorkspaceSelector({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspace,
  loading,
  onSelect,
  onCreate,
  onManage,
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-gray-800">
          <Building2 size={17} className="text-primary-600" />
          Doanh nghiệp đang xử lý
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="text-xs font-semibold text-primary-600 hover:text-primary-700"
        >
          <Plus size={14} className="inline" /> Tạo mới
        </button>
      </div>
      <select
        aria-label="Chọn doanh nghiệp đang xử lý"
        value={selectedWorkspaceId}
        disabled={loading}
        onChange={(event) => onSelect(event.target.value)}
        className="mt-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
      >
        <option value="">Không đối chiếu danh mục MISA</option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      {selectedWorkspace ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <span>
            {selectedWorkspace.misaProduct} ·{" "}
            {selectedWorkspace.activeSnapshots?.length || 0} danh mục hoạt động
          </span>
          <button
            type="button"
            onClick={onManage}
            className="font-bold underline underline-offset-2"
          >
            Quản lý
          </button>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          File vẫn chuyển đổi được nhưng EzFormat chưa thể xác nhận mã có tồn tại trong
          MISA.
        </p>
      )}
      {selectedWorkspace && (
        <button
          type="button"
          onClick={onManage}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50"
        >
          <Database size={14} /> Danh mục MISA
        </button>
      )}
    </div>
  );
}
