import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import {
  filterValidationIssues,
  paginateValidationIssues,
  summarizeValidationIssues,
} from "../utils/validationUi";

const SEVERITY_LABELS = {
  blocker: "Cần sửa",
  warning: "Cảnh báo",
  info: "Thông tin",
};

const SEVERITY_CLASSES = {
  blocker: "bg-red-50 text-red-700 ring-red-100",
  warning: "bg-amber-50 text-amber-700 ring-amber-100",
  info: "bg-blue-50 text-blue-700 ring-blue-100",
};

const FILTERS = [
  { id: "all", label: "Tất cả" },
  { id: "blocker", label: "Cần sửa" },
  { id: "warning", label: "Cảnh báo" },
  { id: "info", label: "Thông tin" },
];

function display(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function ValidationIssueTable({ issues = [] }) {
  const summary = useMemo(() => summarizeValidationIssues(issues), [issues]);
  const [severity, setSeverity] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () => filterValidationIssues(issues, { severity, query }),
    [issues, query, severity],
  );
  const pagination = useMemo(
    () => paginateValidationIssues(filtered, page),
    [filtered, page],
  );

  useEffect(() => {
    setSeverity(summary.blocker > 0 ? "blocker" : "all");
    setQuery("");
    setPage(0);
  }, [issues, summary.blocker]);

  useEffect(() => {
    setPage(0);
  }, [query, severity]);

  if (!issues.length) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
        <h3 className="text-base font-black text-gray-900">Chi tiết lỗi/cảnh báo</h3>
        <p className="mt-1 text-sm text-gray-500">
          Lọc theo mức độ hoặc tìm dòng, cột, chứng từ và giá trị cần rà soát.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={severity === filter.id}
              onClick={() => setSeverity(filter.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition-colors ${
                severity === filter.id
                  ? "bg-primary-600 text-white ring-primary-600"
                  : "bg-gray-50 text-gray-700 ring-gray-200 hover:bg-gray-100"
              }`}
            >
              {filter.label} · {summary[filter.id]}
            </button>
          ))}
        </div>
        <label className="relative mt-3 block max-w-xl">
          <span className="sr-only">Tìm trong lỗi và cảnh báo</span>
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-xl border border-gray-200 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
            placeholder="Tìm dòng, cột, chứng từ hoặc nội dung lỗi"
          />
        </label>
      </div>

      {pagination.items.length ? (
        <>
          <div className="max-h-[560px] overflow-auto">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Mức độ</th>
                  <th className="px-4 py-3 text-left">Dòng</th>
                  <th className="px-4 py-3 text-left">Cột</th>
                  <th className="px-4 py-3 text-left">Nội dung</th>
                  <th className="px-4 py-3 text-left">Hiện tại</th>
                  <th className="px-4 py-3 text-left">Kỳ vọng</th>
                  <th className="px-4 py-3 text-left">Cách sửa</th>
                  <th className="px-4 py-3 text-left">Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {pagination.items.map((issue, index) => (
                  <tr
                    key={`${issue.code || "issue"}-${pagination.start + index}`}
                    className="border-t border-gray-100 align-top"
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${
                          SEVERITY_CLASSES[issue.severity] || SEVERITY_CLASSES.info
                        }`}
                      >
                        {SEVERITY_LABELS[issue.severity] || issue.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{display(issue.row)}</td>
                    <td className="px-4 py-3 font-semibold text-gray-800">
                      {display(issue.field)}
                    </td>
                    <td className="px-4 py-3 text-gray-800">
                      <div>{display(issue.message)}</div>
                      {issue.invoice && (
                        <div className="mt-1 text-xs text-gray-500">
                          Chứng từ: {issue.invoice}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{display(issue.actual)}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {display(issue.expected)}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {display(issue.fix_hint)}
                    </td>
                    <td className="px-4 py-3">
                      {issue.source_url ? (
                        <a
                          href={issue.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-primary-600 hover:underline"
                        >
                          Xem nguồn
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 border-t border-gray-100 px-4 py-3 text-xs text-gray-600 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Hiển thị {pagination.start}–{pagination.end} / {pagination.total} mục
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => current - 1)}
                disabled={pagination.page === 0}
                className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
                aria-label="Trang lỗi trước"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="tabular-nums">
                {pagination.page + 1} / {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={pagination.page >= pagination.totalPages - 1}
                className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
                aria-label="Trang lỗi sau"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-gray-500">
          Không có lỗi hoặc cảnh báo phù hợp với bộ lọc hiện tại.
        </p>
      )}
    </section>
  );
}
