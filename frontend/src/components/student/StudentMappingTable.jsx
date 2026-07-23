import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Columns3, Grid3X3, Search } from "lucide-react";
import {
  buildStudentMappingRows,
  findStudentExplanation,
  getNextStudentTabId,
  setStudentMappingTarget,
} from "../../utils/studentAssistant";

const MODE_LABELS = {
  mapping: "Cột nguồn",
  default: "Mặc định",
  formula: "Công thức",
  mixed: "Nhiều nguồn",
  unresolved: "Chưa ghép",
};

const MODE_TONES = {
  mapping: "bg-emerald-50 text-emerald-700",
  default: "bg-blue-50 text-blue-700",
  formula: "bg-cyan-50 text-cyan-700",
  mixed: "bg-rose-50 text-rose-700",
  unresolved: "bg-amber-50 text-amber-700",
};
const STUDENT_TABS = [
  ["mapping", "Mapping", Columns3],
  ["preview", "Xem trước", Grid3X3],
  ["issues", "Lỗi và cảnh báo", AlertTriangle],
];
const STUDENT_TAB_IDS = STUDENT_TABS.map(([id]) => id);

export default function StudentMappingTable({
  analysis,
  studentWork,
  onStudentWorkChange,
  selectedId,
  onSelectExplanation,
  evidenceNavigation,
}) {
  const [view, setView] = useState("mapping");
  const [query, setQuery] = useState("");
  const tabRefs = useRef({});
  const mappingRows = useMemo(() => buildStudentMappingRows(analysis), [analysis]);
  const explanations = analysis?.explanations || [];
  const studentRows = studentWork?.rows || [];
  const normalizedQuery = query.trim().toLocaleLowerCase("vi");
  const visibleMappings = mappingRows.filter((item) => {
    if (!normalizedQuery) return true;
    return [item.target, ...item.sources, item.defaultValue, item.formula]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase("vi").includes(normalizedQuery));
  });

  useEffect(() => {
    if (!evidenceNavigation) return;
    setView(evidenceNavigation.view || "mapping");
    if (evidenceNavigation.view === "mapping" && evidenceNavigation.sourceField) {
      setQuery(evidenceNavigation.sourceField);
    }
  }, [evidenceNavigation]);

  const selectTarget = (target, options) => {
    const explanation = findStudentExplanation(explanations, target, options);
    if (explanation) onSelectExplanation(explanation);
  };

  const updateMapping = (target, source) => {
    onStudentWorkChange?.((current) => ({
      ...current,
      mapping: setStudentMappingTarget(current?.mapping, target, source),
    }));
  };

  const updateStudentCell = (rowIndex, field, value) => {
    const cellKey = `${rowIndex + 1}:${field}`;
    onStudentWorkChange?.((current) => ({
      ...current,
      rows: (current?.rows || []).map((row, index) =>
        index === rowIndex ? { ...row, [field]: value } : row,
      ),
      edited_cells: [...new Set([...(current?.edited_cells || []), cellKey])],
    }));
  };

  const handleTabKeyDown = (event, currentId) => {
    const nextId = getNextStudentTabId(STUDENT_TAB_IDS, currentId, event.key);
    if (nextId === currentId && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setView(nextId);
    requestAnimationFrame(() => tabRefs.current[nextId]?.focus());
  };

  return (
    <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card">
      <div className="border-b border-slate-100 px-4 pt-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary-600">
              Mapping và dữ liệu
            </p>
            <h2 className="mt-1 text-xl font-black text-gray-950">
              Chọn một mục để xem bằng chứng
            </h2>
          </div>
          <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-gray-600">
            {analysis?.mapping_suggestion?.source || "heuristic"}
          </div>
        </div>
        <div
          className="mt-4 flex gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Dữ liệu phiên học"
          aria-orientation="horizontal"
        >
          {STUDENT_TABS.map(([id, label, Icon]) => (
            <button
              key={id}
              ref={(node) => {
                if (node) tabRefs.current[id] = node;
                else delete tabRefs.current[id];
              }}
              type="button"
              role="tab"
              id={`student-tab-${id}`}
              aria-controls={`student-panel-${id}`}
              aria-selected={view === id}
              tabIndex={view === id ? 0 : -1}
              onClick={() => setView(id)}
              onKeyDown={(event) => handleTabKeyDown(event, id)}
              className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-bold transition-colors ${
                view === id
                  ? "border-primary-600 text-primary-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>
      </div>

      {evidenceNavigation && (
        <div className="border-b border-cyan-100 bg-cyan-50 px-4 py-3 text-xs font-bold text-cyan-900 sm:px-5">
          Evidence: dòng nguồn {evidenceNavigation.sourceRow || "-"} · trường {" "}
          {evidenceNavigation.sourceField || "-"}
          {evidenceNavigation.targetField
            ? ` → ${evidenceNavigation.targetField}`
            : ""}
          {!evidenceNavigation.visibleInPreview && evidenceNavigation.sourceRow
            ? " · dòng chính xác được tải trong bảng Source row bên dưới"
            : ""}
        </div>
      )}

      {view === "mapping" && (
        <div
          id="student-panel-mapping"
          role="tabpanel"
          aria-labelledby="student-tab-mapping"
          tabIndex={0}
        >
          <div className="border-b border-slate-100 p-4 sm:px-5">
            <label className="relative block">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <span className="sr-only">Tìm trường mapping</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm trường đích hoặc cột nguồn"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary-400 focus:bg-white"
              />
            </label>
          </div>
          <div className="max-h-[610px] divide-y divide-slate-100 overflow-y-auto">
            {visibleMappings.map((item) => {
              const explanation = findStudentExplanation(
                explanations,
                item.target,
                {
                  preferredKinds:
                    item.mode === "formula"
                      ? ["calculation", "field"]
                      : ["mapping", "field"],
                },
              );
              const selected = explanation?.id === selectedId;
              const detail =
                item.mode === "formula"
                  ? item.formula
                  : item.mode === "default"
                    ? String(item.defaultValue)
                    : item.sources.join(", ") || "Chưa có nguồn";
              const selectedSource = Object.entries(studentWork?.mapping || {}).find(
                ([, targetSpec]) =>
                  (Array.isArray(targetSpec) ? targetSpec : [targetSpec]).includes(item.target),
              )?.[0] || "";
              return (
                <div
                  key={item.target}
                  className={`grid w-full gap-2 px-4 py-3 text-left transition-colors sm:grid-cols-[minmax(0,1fr)_160px] sm:px-5 ${
                    evidenceNavigation?.targetField === item.target ||
                    item.sources.includes(evidenceNavigation?.sourceField)
                      ? "bg-cyan-50 ring-1 ring-inset ring-cyan-200"
                      : selected
                        ? "bg-primary-50"
                        : "hover:bg-slate-50"
                  }`}
                >
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        selectTarget(item.target, {
                          preferredKinds:
                            item.mode === "formula"
                              ? ["calculation", "field"]
                              : ["mapping", "field"],
                        })
                      }
                      className="text-left"
                      aria-pressed={selected}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-gray-900">{item.target}</span>
                      {item.required && (
                        <span className="text-[10px] font-black uppercase text-red-600">
                          Bắt buộc
                        </span>
                      )}
                      </span>
                      <span className="mt-1 block truncate text-xs text-gray-500" title={detail}>
                        {detail}
                      </span>
                    </button>
                  </div>
                  <label className="text-xs font-bold text-slate-600">
                    Mapping của bạn
                    <select
                      value={selectedSource}
                      onChange={(event) => updateMapping(item.target, event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs outline-none focus:border-primary-400"
                    >
                      <option value="">Chưa ghép</option>
                      {(analysis?.detected?.headers || []).map((source) => (
                        <option key={source} value={source}>
                          {source}
                        </option>
                      ))}
                    </select>
                    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] ${MODE_TONES[item.mode]}`}>
                      {MODE_LABELS[item.mode]}
                    </span>
                  </label>
                </div>
              );
            })}
            {!visibleMappings.length && (
              <p className="p-8 text-center text-sm text-gray-500">
                Không có trường phù hợp bộ lọc.
              </p>
            )}
          </div>
        </div>
      )}

      {view === "preview" && (
        <div
          id="student-panel-preview"
          className="table-scroll max-h-[610px] overflow-auto"
          role="tabpanel"
          aria-labelledby="student-tab-preview"
          tabIndex={0}
        >
          <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <th className="border-b border-slate-200 px-3 py-3 font-black text-gray-500">
                  #
                </th>
                {(analysis?.student_preview?.headers || []).map((header) => (
                  <th
                    key={header}
                    className="min-w-36 border-b border-slate-200 px-3 py-3 font-black text-gray-700"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {studentRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/50">
                  <td className="border-b border-slate-100 px-3 py-2 font-bold text-gray-400">
                    {rowIndex + 1}
                  </td>
                  {(analysis?.student_preview?.headers || []).map((header) => (
                    <td
                      key={header}
                      className={`border-b border-slate-100 p-1.5 ${
                        evidenceNavigation?.visibleInPreview &&
                        evidenceNavigation.previewRow === rowIndex + 1 &&
                        evidenceNavigation.targetField === header
                          ? "bg-cyan-100 ring-2 ring-inset ring-cyan-400"
                          : ""
                      }`}
                    >
                      <label className="block">
                        <span className="sr-only">Chỉnh dòng {rowIndex + 1}, trường {header}</span>
                        <input
                          value={row[header] ?? ""}
                          onFocus={() =>
                            selectTarget(header, {
                              preferredKinds: ["issue", "normalization", "mapping", "field"],
                              previewRow: rowIndex + 1,
                              sourceRow:
                                Number(analysis?.detected?.header_row || 1) + rowIndex + 1,
                            })
                          }
                          onChange={(event) =>
                            updateStudentCell(rowIndex, header, event.target.value)
                          }
                          className={`w-full min-w-32 rounded-lg border px-2 py-1.5 text-gray-700 outline-none focus:border-primary-400 focus:bg-white ${
                            studentWork?.edited_cells?.includes(`${rowIndex + 1}:${header}`)
                              ? "border-cyan-300 bg-cyan-50"
                              : "border-transparent bg-transparent hover:border-slate-200 hover:bg-white"
                          }`}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {analysis?.student_preview?.truncated && (
            <p className="border-t border-slate-100 p-3 text-center text-xs text-gray-500">
              Chỉ hiển thị 25 dòng đầu; summary và readiness vẫn chạy trên toàn bộ file.
            </p>
          )}
        </div>
      )}

      {view === "issues" && (
        <div
          id="student-panel-issues"
          className="max-h-[610px] divide-y divide-slate-100 overflow-y-auto"
          role="tabpanel"
          aria-labelledby="student-tab-issues"
          tabIndex={0}
        >
          {(analysis?.readiness?.issues || []).map((issue, index) => {
            const explanation = findStudentExplanation(
              explanations,
              issue.field || null,
              {
                preferredKinds: ["issue"],
                issueCode: issue.code,
                issueRow: issue.row || null,
              },
            );
            return (
              <button
                key={`${issue.code}-${issue.row || "all"}-${index}`}
                type="button"
                onClick={() => explanation && onSelectExplanation(explanation)}
                className={`w-full px-4 py-4 text-left transition-colors hover:bg-slate-50 sm:px-5 ${
                  explanation?.id === selectedId ? "bg-primary-50" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
                      issue.severity === "blocker"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {issue.severity}
                  </span>
                  <span className="text-xs font-bold text-gray-500">
                    {issue.field || issue.category} {issue.row ? `· dòng ${issue.row}` : ""}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold leading-6 text-gray-800">
                  {issue.message}
                </p>
              </button>
            );
          })}
          {!analysis?.readiness?.issues?.length && (
            <div className="p-10 text-center">
              <p className="font-bold text-emerald-700">Không có lỗi readiness.</p>
              <p className="mt-1 text-sm text-gray-500">
                Vẫn cần đối chiếu nghiệp vụ trước khi dùng dữ liệu.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
