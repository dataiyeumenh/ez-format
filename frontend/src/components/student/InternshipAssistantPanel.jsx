import { useMemo, useState } from "react";
import { Download, FileCheck2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import {
  buildInternshipReportRequest,
  canExportAnonymizedWorkbook,
  filterStudentActivities,
  getStudentActivitySkillSummary,
} from "../../utils/studentAssistant";

function downloadResult(result) {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function InternshipAssistantPanel({
  activities,
  loading,
  error,
  onRefresh,
  onDelete,
  onPreview,
  onExport,
  onGenerateReport,
}) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState([]);
  const [fullDocuments, setFullDocuments] = useState(false);
  const [preview, setPreview] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const visible = useMemo(
    () => filterStudentActivities(activities, filter),
    [activities, filter],
  );
  const skills = useMemo(
    () => getStudentActivitySkillSummary(activities),
    [activities],
  );

  const run = async (kind, action) => {
    setBusy(kind);
    setMessage("");
    try {
      await action();
    } catch (requestError) {
      setMessage(requestError.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-5">
        <article className="rounded-3xl border border-emerald-200 bg-emerald-950 p-5 text-white shadow-card">
          <ShieldCheck size={28} className="text-emerald-300" />
          <h2 className="mt-3 text-xl font-black">Workbook ẩn danh</h2>
          <p className="mt-2 text-sm leading-6 text-emerald-100">
            Luôn tạo bản sao mới. Export chỉ mở sau khi scanner đạt và bạn xác nhận đã
            hiểu phạm vi.
          </p>
          <label className="mt-4 flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={fullDocuments}
              onChange={(event) => {
                setFullDocuments(event.target.checked);
                setPreview(null);
                setAcknowledged(false);
              }}
            />
            Ẩn cả số hóa đơn/chứng từ
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run("preview", async () => setPreview(await onPreview(fullDocuments)))
            }
            className="mt-4 rounded-xl bg-white px-4 py-2 text-sm font-black text-emerald-950"
          >
            Xem trước phạm vi
          </button>
          {preview && (
            <div className="mt-4 rounded-2xl bg-white/10 p-3 text-sm">
              Scanner: <strong>{preview.scanner_status}</strong>
              <br />
              Nhóm thay thế:{" "}
              {(preview.replaced_categories || []).join(", ") || "không có"}
            </div>
          )}
          <label className="mt-4 flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            Tôi hiểu đây là bản sao và vẫn cần rà soát trước khi chia sẻ.
          </label>
          <button
            type="button"
            disabled={busy || !canExportAnonymizedWorkbook(acknowledged, preview)}
            onClick={() =>
              run("export", async () => downloadResult(await onExport(fullDocuments)))
            }
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-300 px-4 py-2 text-sm font-black text-emerald-950 disabled:opacity-40"
          >
            <Download size={16} />
            Xuất bản ẩn danh
          </button>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
          <h3 className="font-black text-slate-950">Skill summary</h3>
          <div className="mt-3 space-y-2">
            {skills.map((item) => (
              <div
                key={item.skill}
                className="flex justify-between rounded-xl bg-slate-50 p-3 text-sm"
              >
                <span>{item.skill}</span>
                <strong>
                  {item.actions} hoạt động · {item.evidenceCount} evidence
                </strong>
              </div>
            ))}
          </div>
        </article>
      </div>
      <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black text-slate-950">Internship Activity</h2>
            <p className="text-sm text-slate-500">
              Chỉ metadata đã xác minh, không lưu dòng raw.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-xl border p-2"
              aria-label="Tải lại"
            >
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-xl border border-rose-200 p-2 text-rose-700"
              aria-label="Xóa lịch sử"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="mt-4 rounded-xl border border-slate-200 px-3 py-2 text-sm"
        >
          <option value="all">Tất cả</option>
          <option value="accounting_map_reviewed">Accounting map</option>
          <option value="reconciliation_completed">Reconciliation</option>
          <option value="anonymized_export_created">Anonymization</option>
        </select>
        {loading && <p className="mt-4 text-sm text-slate-500">Đang tải hoạt động…</p>}
        {error && <p className="mt-4 text-sm font-bold text-rose-700">{error}</p>}
        <div className="mt-4 space-y-2">
          {visible.map((activity) => (
            <label
              key={activity.id}
              className="flex gap-3 rounded-2xl border border-slate-200 p-3"
            >
              <input
                type="checkbox"
                checked={selected.includes(activity.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, activity.id]
                      : current.filter((id) => id !== activity.id),
                  )
                }
              />
              <span>
                <strong className="block text-sm text-slate-950">
                  {activity.summaryVi}
                </strong>
                <span className="text-xs text-slate-500">
                  {activity.skill} · {activity.evidenceCount} evidence
                </span>
              </span>
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Ghi chú đã được bạn phê duyệt (tùy chọn)"
          className="mt-4 w-full rounded-xl border border-slate-200 p-3 text-sm"
        />
        <button
          type="button"
          disabled={busy || selected.length === 0}
          onClick={() =>
            run("report", async () =>
              downloadResult(
                await onGenerateReport(buildInternshipReportRequest(selected, note)),
              ),
            )
          }
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white disabled:opacity-40"
        >
          <FileCheck2 size={16} />
          Tạo báo cáo bàn giao
        </button>
        {message && <p className="mt-3 text-sm font-bold text-rose-700">{message}</p>}
      </article>
    </section>
  );
}
