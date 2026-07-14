import { useMemo, useState } from "react";
import { Check, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import {
  CATALOG_LABELS,
  PRIMARY_CATALOG_TYPES,
  indexMasterDataSnapshots,
} from "../../utils/masterData";

export default function MasterDataManager({
  open,
  workspace,
  snapshots,
  onClose,
  onImport,
  onActivate,
}) {
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const snapshotsByType = useMemo(
    () => indexMasterDataSnapshots(snapshots),
    [snapshots],
  );

  if (!open || !workspace) return null;

  const upload = async (type, file) => {
    if (!file) return;
    setBusyKey(`upload-${type}`);
    setError("");
    try {
      await onImport(type, file);
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setBusyKey("");
    }
  };

  const activate = async (snapshot) => {
    setBusyKey(`activate-${snapshot.id}`);
    setError("");
    try {
      await onActivate(snapshot.id);
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-data-title"
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="master-data-title" className="text-xl font-black text-gray-900">
              Danh mục MISA
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {workspace.name} · tải từng danh mục khi cần, không bắt buộc đủ tất cả.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"
            aria-label="Đóng"
          >
            <X size={20} />
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {PRIMARY_CATALOG_TYPES.map((type) => {
            const typeSnapshots = snapshotsByType[type];
            const activeSnapshot = typeSnapshots?.active || null;
            const readySnapshot = typeSnapshots?.ready || null;
            const failedSnapshot =
              typeSnapshots?.latest?.status === "failed" ? typeSnapshots.latest : null;
            const displayedSnapshot =
              readySnapshot || activeSnapshot || typeSnapshots?.latest || null;
            const uploading = busyKey === `upload-${type}`;
            const activating =
              readySnapshot && busyKey === `activate-${readySnapshot.id}`;
            return (
              <div key={type} className="rounded-2xl border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-gray-900">{CATALOG_LABELS[type]}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {displayedSnapshot
                        ? `${displayedSnapshot.rowCount} mã · ${displayedSnapshot.sourceFileName}`
                        : "Chưa có dữ liệu"}
                    </p>
                  </div>
                  {readySnapshot ? (
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-bold text-amber-700">
                      Chờ kích hoạt
                    </span>
                  ) : activeSnapshot ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-bold text-emerald-700">
                      Đang dùng
                    </span>
                  ) : null}
                </div>
                {readySnapshot && activeSnapshot && (
                  <p className="mt-2 text-xs text-gray-500">
                    Đang dùng: {activeSnapshot.sourceFileName}. Kích hoạt để chuyển sang
                    bản mới.
                  </p>
                )}
                {displayedSnapshot?.warnings?.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    {displayedSnapshot.warnings[0]}
                  </p>
                )}
                {failedSnapshot && (
                  <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700">
                    {failedSnapshot.sourceFileName}:{" "}
                    {failedSnapshot.errorMessage || "Không đọc được file danh mục này."}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                    {uploading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Upload size={14} />
                    )}
                    Tải file
                    <input
                      type="file"
                      accept=".xls,.xlsx"
                      className="hidden"
                      disabled={Boolean(busyKey)}
                      onChange={(event) => {
                        upload(type, event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {readySnapshot && (
                    <button
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => activate(readySnapshot)}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-3 py-2 text-xs font-bold text-white hover:bg-primary-700"
                    >
                      {activating ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}{" "}
                      Kích hoạt
                    </button>
                  )}
                  {!displayedSnapshot && (
                    <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                      <FileSpreadsheet size={13} /> .xls hoặc .xlsx
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
