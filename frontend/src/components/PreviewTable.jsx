import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

const PAGE_SIZE = 50;

export default function PreviewTable({
  headers,
  rows,
  onCellChange,
  onDeleteRow,
  disabled,
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  useEffect(() => {
    setPage(0);
  }, [rows.length, headers.length]);

  const pageRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, page]);

  const startRow = page * PAGE_SIZE;

  return (
    <div className="rounded-2xl border border-gray-200/80 bg-white shadow-card overflow-hidden animate-fade-in">
      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/80 px-4 py-2 text-xs text-gray-600">
          <span>
            Hiển thị {startRow + 1}–{Math.min(startRow + PAGE_SIZE, rows.length)} /{" "}
            {rows.length} dòng
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0 || disabled}
              onClick={() => setPage((p) => p - 1)}
              className="p-1.5 rounded-lg hover:bg-white disabled:opacity-40 transition-colors"
              aria-label="Trang trước"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="tabular-nums px-1">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages - 1 || disabled}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 rounded-lg hover:bg-white disabled:opacity-40 transition-colors"
              aria-label="Trang sau"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="table-scroll w-full overflow-auto" style={{ maxHeight: "62vh" }}>
        <table className="min-w-max w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 bg-gray-50 border-b border-r border-gray-200 px-3 py-2.5 text-gray-500 font-semibold text-center w-11">
                #
              </th>
              {headers.map((h) => (
                <th
                  key={h}
                  className="bg-gray-50 border-b border-r border-gray-200 px-3 py-2.5 text-left text-gray-700 font-semibold whitespace-nowrap min-w-[128px]"
                >
                  {h}
                </th>
              ))}
              <th className="bg-gray-50 border-b border-gray-200 px-3 py-2.5 text-center text-gray-500 font-semibold w-12">
                Xoá
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, localIdx) => {
              const rIdx = startRow + localIdx;
              return (
                <tr
                  key={`row-${rIdx}`}
                  className="group transition-colors hover:bg-primary-50/40"
                >
                  <td className="sticky left-0 z-10 bg-white group-hover:bg-primary-50/40 border-b border-r border-gray-100 px-3 py-1.5 text-center text-gray-400 font-mono text-[11px] select-none">
                    {rIdx + 1}
                  </td>
                  {headers.map((h) => (
                    <td
                      key={`${rIdx}-${h}`}
                      className="border-b border-r border-gray-100 p-0"
                    >
                      <input
                        type="text"
                        disabled={disabled}
                        value={
                          row[h] !== undefined && row[h] !== null ? String(row[h]) : ""
                        }
                        onChange={(e) => onCellChange(rIdx, h, e.target.value)}
                        className="w-full min-w-[128px] px-3 py-2 text-xs text-gray-800 bg-transparent border-none outline-none transition-colors focus:bg-primary-50 focus:ring-1 focus:ring-inset focus:ring-primary-400 disabled:opacity-60"
                      />
                    </td>
                  ))}
                  <td className="border-b border-gray-100 px-2 py-1 text-center">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onDeleteRow(rIdx)}
                      className="rounded-md p-1 text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 transition-all disabled:opacity-30"
                      title="Xoá dòng này"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
