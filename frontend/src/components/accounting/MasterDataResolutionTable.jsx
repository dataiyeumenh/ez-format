import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
  Search,
} from "lucide-react";
import {
  CATALOG_LABELS,
  filterMasterDataResolutions,
  groupMasterDataResolutions,
  paginateMasterDataResolutions,
  summarizeResolutionGroups,
} from "../../utils/masterData";

const STATUS_LABELS = {
  verified: "Đã khớp",
  suggested: "Cần xác nhận",
  missing: "Chưa có mã",
  conflict: "Xung đột",
  not_checked: "Chưa kiểm tra",
};

const FILTERS = [
  { id: "all", label: "Tất cả", countKey: "total" },
  { id: "action_required", label: "Cần xử lý", countKey: "actionRequired" },
  { id: "not_checked", label: "Chưa kiểm tra", countKey: "notChecked" },
  { id: "verified", label: "Đã khớp", countKey: "verified" },
];

export default function MasterDataResolutionTable({
  masterData,
  onConfirmAlias,
  onSearchCandidates,
  onSetupWorkspace,
  onManageMasterData,
  hasWorkspace = false,
}) {
  const [selected, setSelected] = useState({});
  const [queries, setQueries] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [savingKey, setSavingKey] = useState("");
  const [searchingKey, setSearchingKey] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const resolutions = useMemo(
    () => groupMasterDataResolutions(masterData?.resolutions || []),
    [masterData?.resolutions],
  );
  const summary = useMemo(
    () => summarizeResolutionGroups(resolutions),
    [resolutions],
  );
  const filtered = useMemo(
    () => filterMasterDataResolutions(resolutions, { statusFilter, query }),
    [query, resolutions, statusFilter],
  );
  const pagination = useMemo(
    () => paginateMasterDataResolutions(filtered, page),
    [filtered, page],
  );
  const onlyNotChecked = summary.total > 0 && summary.notChecked === summary.total;
  const workspaceAction = hasWorkspace ? onManageMasterData : onSetupWorkspace;

  useEffect(() => {
    if (summary.requiredCritical > 0) {
      setExpanded(true);
      setStatusFilter("action_required");
    }
  }, [summary.requiredCritical]);

  useEffect(() => {
    setPage(0);
  }, [query, statusFilter, resolutions.length]);

  if (!resolutions.length) return null;

  const confirm = async (item, key, candidates) => {
    const targetCode = selected[key] || candidates?.[0]?.code || "";
    if (!targetCode) return;
    setSavingKey(key);
    setError("");
    try {
      await onConfirmAlias(item, targetCode);
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setSavingKey("");
    }
  };

  const search = async (item, key) => {
    if (!onSearchCandidates) return;
    setSearchingKey(key);
    setError("");
    try {
      const items = await onSearchCandidates(
        item.catalog_type,
        queries[key] || item.raw_value,
      );
      setSearchResults((current) => ({ ...current, [key]: items }));
      if (items.length === 1) {
        setSelected((current) => ({ ...current, [key]: items[0].code }));
      }
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message);
    } finally {
      setSearchingKey("");
    }
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left hover:bg-gray-50"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls="master-data-resolution-content"
      >
        <div>
          <h3 className="font-black text-gray-900">Đối chiếu danh mục MISA</h3>
          <p className="mt-1 text-sm text-gray-500">
            {summary.total} giá trị đã được gom nhóm; mở danh sách khi cần rà soát mã.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">
              {summary.actionRequired} cần xử lý
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
              {summary.notChecked} chưa kiểm tra
            </span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">
              {summary.verified} đã khớp
            </span>
          </div>
        </div>
        {expanded ? (
          <ChevronUp size={20} className="mt-1 shrink-0 text-gray-500" />
        ) : (
          <ChevronDown size={20} className="mt-1 shrink-0 text-gray-500" />
        )}
      </button>

      {onlyNotChecked && (
        <div className="border-t border-amber-100 bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Chưa có danh mục MISA đang hoạt động nên các mã này chưa được xác nhận.
            </span>
            {workspaceAction && (
              <button
                type="button"
                className="w-fit font-bold text-amber-950 underline underline-offset-2"
                onClick={workspaceAction}
              >
                {hasWorkspace ? "Quản lý danh mục MISA" : "Tạo hồ sơ doanh nghiệp"}
              </button>
            )}
          </div>
        </div>
      )}

      {expanded && (
        <div id="master-data-resolution-content" className="border-t border-gray-100">
          <div className="space-y-3 border-b border-gray-100 bg-gray-50/70 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={statusFilter === filter.id}
                  onClick={() => setStatusFilter(filter.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition-colors ${
                    statusFilter === filter.id
                      ? "bg-primary-600 text-white ring-primary-600"
                      : "bg-white text-gray-700 ring-gray-200 hover:bg-gray-100"
                  }`}
                >
                  {filter.label} · {summary[filter.countKey]}
                </button>
              ))}
            </div>
            <label className="relative block max-w-xl">
              <span className="sr-only">Tìm trong danh mục đối chiếu</span>
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
                placeholder="Tìm mã, tên, cột hoặc loại danh mục"
              />
            </label>
            {error && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
          </div>

          {pagination.items.length ? (
            <>
              <div className="max-h-[560px] overflow-auto">
                <table className="min-w-[840px] w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Danh mục</th>
                      <th className="px-4 py-3">Giá trị raw</th>
                      <th className="px-4 py-3">Trạng thái</th>
                      <th className="px-4 py-3">Ảnh hưởng</th>
                      <th className="px-4 py-3">Mã MISA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagination.items.map((item) => {
                      const key = `${item.catalog_type}|${item.field}|${item.raw_value}`;
                      const canResolve = ["suggested", "missing", "conflict"].includes(
                        item.status,
                      );
                      const candidates = [
                        ...(item.candidates || []),
                        ...(searchResults[key] || []).map((candidate) => ({
                          code: candidate.code,
                          name: candidate.name,
                          tax_code: candidate.taxCode,
                        })),
                      ].filter(
                        (candidate, index, items) =>
                          candidate.code &&
                          items.findIndex((entry) => entry.code === candidate.code) ===
                            index,
                      );
                      return (
                        <tr key={key} className="border-t border-gray-100 align-top">
                          <td className="px-4 py-3 font-semibold text-gray-700">
                            {CATALOG_LABELS[item.catalog_type] || item.catalog_type}
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900">{item.raw_value}</p>
                            <p className="text-xs text-gray-400">{item.field}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded-full px-2 py-1 text-xs font-bold ${item.status === "verified" ? "bg-emerald-100 text-emerald-700" : item.status === "conflict" || (item.status === "missing" && item.required) ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
                            >
                              {STATUS_LABELS[item.status] || item.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {item.affected_rows} dòng
                          </td>
                          <td className="px-4 py-3">
                            {canResolve ? (
                              <div className="min-w-[300px] space-y-2">
                                <div className="flex gap-2">
                                  <input
                                    value={queries[key] || ""}
                                    onChange={(event) =>
                                      setQueries((current) => ({
                                        ...current,
                                        [key]: event.target.value,
                                      }))
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        search(item, key);
                                      }
                                    }}
                                    className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5"
                                    placeholder="Tìm mã hoặc tên trong MISA"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => search(item, key)}
                                    disabled={searchingKey === key}
                                    className="rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-50"
                                    aria-label="Tìm mã MISA"
                                  >
                                    {searchingKey === key ? (
                                      <Loader2 size={15} className="animate-spin" />
                                    ) : (
                                      <Search size={15} />
                                    )}
                                  </button>
                                </div>
                                <div className="flex gap-2">
                                  <select
                                    value={selected[key] || candidates[0]?.code || ""}
                                    onChange={(event) =>
                                      setSelected((current) => ({
                                        ...current,
                                        [key]: event.target.value,
                                      }))
                                    }
                                    className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5"
                                  >
                                    <option value="">Chọn mã</option>
                                    {candidates.map((candidate) => (
                                      <option key={candidate.code} value={candidate.code}>
                                        {candidate.code} — {candidate.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => confirm(item, key, candidates)}
                                    disabled={
                                      savingKey === key ||
                                      !(selected[key] || candidates[0]?.code)
                                    }
                                    className="rounded-lg bg-primary-600 p-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                                    aria-label="Xác nhận alias"
                                  >
                                    {savingKey === key ? (
                                      <Loader2 size={15} className="animate-spin" />
                                    ) : (
                                      <Check size={15} />
                                    )}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-600">
                                {item.target_code || "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
                    aria-label="Trang đối chiếu trước"
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
                    aria-label="Trang đối chiếu sau"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-gray-500">
              Không có giá trị phù hợp với bộ lọc hiện tại.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
