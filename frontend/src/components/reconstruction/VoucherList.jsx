import {
  RECONSTRUCTION_STATUS,
  reconstructionTypeLabel,
} from "../../utils/reconstruction";

export default function VoucherList({
  drafts,
  selectedId,
  onSelect,
  mergeSelection,
  onMergeSelectionChange,
}) {
  return (
    <div className="divide-y divide-gray-100">
      {(drafts || []).map((draft) => {
        const status =
          RECONSTRUCTION_STATUS[draft.status] || RECONSTRUCTION_STATUS.needs_review;
        const invoice = draft.header?.invoice_number?.value || "Chưa có số HĐ";
        const partner =
          draft.header?.supplier_name?.value ||
          draft.header?.customer_name?.value ||
          "Chưa xác định đối tượng";
        return (
          <div
            key={draft.id}
            className={`flex gap-3 px-3 py-3 transition-colors ${
              selectedId === draft.id ? "bg-primary-50" : "hover:bg-gray-50"
            }`}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600"
              aria-label={`Chọn ${invoice} để gộp`}
              checked={mergeSelection.includes(draft.id)}
              onChange={(event) =>
                onMergeSelectionChange(draft.id, event.target.checked)
              }
            />
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelect(draft.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-gray-900">{invoice}</p>
                  <p className="mt-0.5 truncate text-xs text-gray-500">{partner}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ring-1 ${status.className}`}
                >
                  {status.label}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                <span>{reconstructionTypeLabel(draft)}</span>
                <span>
                  {draft.lines?.length || 0} dòng · {draft.totals?.payment || "0"} đ
                </span>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
