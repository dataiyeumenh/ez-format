import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { buildCorrectionSelection } from "../../utils/converterOperations.js";

function groupLabel(group) {
  return (
    group.label ||
    group.name ||
    [group.operation, group.field].filter(Boolean).join(" · ") ||
    "Thay đổi dữ liệu"
  );
}

export default function BulkCorrectionDialog({
  open,
  onOpenChange,
  patchSet = null,
  simulation = null,
  loading = false,
  error = "",
  stale = false,
  latestRevision = null,
  onSimulate,
  onApply,
  onUndo,
}) {
  const [stage, setStage] = useState("select");
  const [selectedIds, setSelectedIds] = useState([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const groups = useMemo(() => patchSet?.patches || patchSet?.groups || [], [patchSet]);
  const selection = useMemo(
    () => buildCorrectionSelection(patchSet || {}, selectedIds),
    [patchSet, selectedIds],
  );

  useEffect(() => {
    if (!open) return;
    setStage("select");
    setAcknowledged(false);
    setSelectedIds(
      groups
        .filter((group) => group.selected_by_default === true || group.safe === true)
        .map((group) => String(group.patch_id || group.id)),
    );
  }, [open, groups]);

  const toggleGroup = (id) => {
    const key = String(id);
    setSelectedIds((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  };

  const showPreview = async () => {
    try {
      await onSimulate?.(selection.selectedIds);
      setStage("preview");
    } catch {
      // Parent keeps the detailed request error visible in the dialog.
    }
  };

  const apply = async () => {
    try {
      await onApply?.(selection.selectedIds, acknowledged);
    } catch {
      // Keep the preview open so the user can recover or retry safely.
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/45 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed inset-0 z-[91] flex flex-col bg-white outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[88vh] sm:w-[min(920px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:shadow-2xl">
          <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
            <div>
              <Dialog.Title className="text-xl font-black text-slate-950">
                Sửa lỗi hàng loạt
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-600">
                Bước{" "}
                {stage === "select"
                  ? "1/2 · Chọn thay đổi"
                  : "2/2 · Xem trước và xác nhận"}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
              aria-label="Đóng sửa lỗi hàng loạt"
            >
              <X size={20} />
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            {stale && (
              <div
                role="alert"
                className="mb-4 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
              >
                <AlertTriangle className="mt-0.5 shrink-0" size={18} />
                Dữ liệu đã thay đổi. Đóng hộp thoại và tạo lại đề xuất trên phiên bản
                mới nhất.
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800"
              >
                {error}
              </div>
            )}

            {stage === "select" ? (
              <div className="space-y-3">
                {groups.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-600">
                    Chưa tìm thấy nhóm sửa an toàn. EzFormat không tự thay đổi dữ liệu
                    mơ hồ.
                  </div>
                ) : (
                  groups.map((group) => {
                    const groupId = String(group.patch_id || group.id);
                    const safe = group.risk === "safe" || group.safe === true;
                    const checked = selectedIds.includes(groupId);
                    return (
                      <label
                        key={groupId}
                        className={`flex min-h-16 cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${checked ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 h-5 w-5 rounded border-slate-300 text-blue-600"
                          checked={checked}
                          onChange={() => toggleGroup(groupId)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2 font-bold text-slate-900">
                            {groupLabel(group)}
                            <span
                              className={`text-xs ${safe ? "text-emerald-700" : "text-amber-700"}`}
                            >
                              {safe ? "An toàn" : "Cần xác nhận thủ công"}
                            </span>
                          </span>
                          <span className="mt-1 block text-sm text-slate-600">
                            {Number(
                              group.affected_cells || group.row_ids?.length || 1,
                            ).toLocaleString("vi-VN")}{" "}
                            ô · {group.example_before ?? "—"} →{" "}
                            {group.after_value ?? group.example_after ?? "—"}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
                <div className="flex gap-3 rounded-2xl bg-slate-950 p-4 text-sm text-white">
                  <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={19} />
                  Không tự động sửa tiền, thuế suất, tài khoản, dấu âm/dương hoặc phân
                  loại nghiệp vụ.
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl bg-blue-50 p-4">
                    <p className="text-xs font-bold uppercase text-blue-700">Số ô</p>
                    <p className="mt-1 text-2xl font-black text-blue-950">
                      {Number(
                        simulation?.summary?.affected_cells ??
                          simulation?.summary?.patch_count ??
                          selection.affectedCells,
                      ).toLocaleString("vi-VN")}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-100 p-4">
                    <p className="text-xs font-bold uppercase text-slate-600">
                      Số dòng
                    </p>
                    <p className="mt-1 text-2xl font-black text-slate-950">
                      {Number(simulation?.summary?.affected_rows || 0).toLocaleString(
                        "vi-VN",
                      )}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-emerald-50 p-4">
                    <p className="text-xs font-bold uppercase text-emerald-700">
                      Tiền thay đổi
                    </p>
                    <p className="mt-1 text-2xl font-black text-emerald-950">
                      {simulation?.money_delta || "0 VND"}
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="min-w-[720px] w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-4 py-3">Dòng</th>
                        <th className="px-4 py-3">Cột</th>
                        <th className="px-4 py-3">Trước</th>
                        <th className="px-4 py-3">Sau</th>
                        <th className="px-4 py-3">Nguồn</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(simulation?.diffs || simulation?.changes || []).map(
                        (change, index) => (
                          <tr
                            key={change.patch_id || change.id || index}
                            className="border-t border-slate-100"
                          >
                            <td className="px-4 py-3">
                              {change.row || change.row_id || "—"}
                            </td>
                            <td className="px-4 py-3 font-semibold">
                              {change.field || "—"}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {String(change.before ?? "—")}
                            </td>
                            <td className="px-4 py-3 font-semibold text-slate-950">
                              {String(change.after ?? "—")}
                            </td>
                            <td className="px-4 py-3">
                              {change.source || change.rule_id || "Quy tắc"}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                {selection.requiresAcknowledgement && (
                  <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-950">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-5 w-5"
                      checked={acknowledged}
                      onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    Tôi đã xem các thay đổi cần xác nhận thủ công.
                  </label>
                )}
              </div>
            )}
          </div>

          <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              {latestRevision && onUndo && (
                <button
                  type="button"
                  className="btn-secondary min-h-11"
                  disabled={loading}
                  onClick={onUndo}
                >
                  <RotateCcw size={16} /> Hoàn tác phiên bản {latestRevision}
                </button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {stage === "preview" && (
                <button
                  type="button"
                  className="btn-secondary min-h-11"
                  disabled={loading}
                  onClick={() => setStage("select")}
                >
                  <ArrowLeft size={16} /> Quay lại
                </button>
              )}
              {stage === "select" ? (
                <button
                  type="button"
                  className="btn-primary min-h-11"
                  disabled={loading || stale || selection.selectedIds.length === 0}
                  onClick={showPreview}
                >
                  {loading && <Loader2 size={16} className="animate-spin" />}Xem trước{" "}
                  {selection.affectedCells.toLocaleString("vi-VN")} thay đổi
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary min-h-11"
                  disabled={
                    loading ||
                    stale ||
                    (selection.requiresAcknowledgement && !acknowledged)
                  }
                  onClick={apply}
                >
                  {loading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  Áp dụng thay đổi
                </button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
