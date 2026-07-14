import { useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { CATALOG_LABELS, groupMasterDataResolutions } from "../../utils/masterData";

const STATUS_LABELS = {
  verified: "Đã khớp",
  suggested: "Cần xác nhận",
  missing: "Chưa có mã",
  conflict: "Xung đột",
  not_checked: "Chưa kiểm tra",
};

export default function MasterDataResolutionTable({
  masterData,
  onConfirmAlias,
  onSearchCandidates,
}) {
  const [selected, setSelected] = useState({});
  const [queries, setQueries] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [savingKey, setSavingKey] = useState("");
  const [searchingKey, setSearchingKey] = useState("");
  const [error, setError] = useState("");
  const resolutions = useMemo(
    () => groupMasterDataResolutions(masterData?.resolutions || []),
    [masterData?.resolutions],
  );
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
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-4">
        <h3 className="font-black text-gray-900">Đối chiếu danh mục MISA</h3>
        <p className="mt-1 text-sm text-gray-500">
          Các giá trị giống nhau được gom lại để chỉ cần xử lý một lần.
        </p>
        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Danh mục</th>
              <th className="px-4 py-3">Giá trị raw</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Ảnh hưởng</th>
              <th className="px-4 py-3">Mã MISA</th>
            </tr>
          </thead>
          <tbody>
            {resolutions.map((item) => {
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
                  items.findIndex((entry) => entry.code === candidate.code) === index,
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
                  <td className="px-4 py-3 text-gray-600">{item.affected_rows} dòng</td>
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
                      <span className="text-gray-600">{item.target_code || "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
