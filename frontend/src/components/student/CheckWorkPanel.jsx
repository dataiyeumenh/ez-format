import { CheckCircle2, Lightbulb, Loader2, LockKeyhole } from "lucide-react";
import {
  formatStudentAttemptRevision,
  getStudentHintLevelState,
  getStudentScoreBand,
} from "../../utils/studentAssistant";
import SkillProgressCard from "./SkillProgressCard";

const SCORE_TONES = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  rose: "border-rose-200 bg-rose-50 text-rose-900",
};

export default function CheckWorkPanel({
  result,
  progress,
  history = [],
  loading = false,
  error = "",
  revealedLevels = {},
  revealedHints = {},
  classification = "",
  classificationOptions = [],
  onClassificationChange,
  onSubmit,
  onRevealHint,
}) {
  const evaluation = result?.evaluation;
  const attempt = result?.attempt;
  const band = getStudentScoreBand(evaluation?.score);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] text-primary-600">
            Check My Work
          </p>
          <h2 className="mt-2 text-2xl font-black text-slate-950">
            Chấm mapping và dữ liệu bằng rubric deterministic
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            AI không được đổi điểm. Gợi ý mở từng cấp và đáp án kỳ vọng vẫn ở server
            cho đến khi bạn chủ động yêu cầu.
          </p>
        </div>
        <button type="button" onClick={onSubmit} disabled={loading} className="btn-primary">
          {loading ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
          {loading ? "Đang chấm…" : "Kiểm tra bài hiện tại"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </p>
      )}

      <label className="mt-5 block max-w-md text-sm font-bold text-slate-800">
        Phân loại chứng từ của bạn
        <select
          value={classification}
          onChange={(event) => onClassificationChange?.(event.target.value)}
          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-primary-400"
        >
          <option value="">Chưa phân loại</option>
          {classificationOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-6">
        <SkillProgressCard progress={progress} />
      </div>

      {evaluation ? (
        <div className="mt-6 space-y-5">
          <div className={`rounded-2xl border p-5 ${SCORE_TONES[band.tone]}`}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.12em] opacity-70">
                  {formatStudentAttemptRevision(attempt)} · {evaluation.rubric_version}
                </p>
                <p className="mt-2 text-4xl font-black">{evaluation.score}/100</p>
              </div>
              <span className="rounded-full bg-white/80 px-3 py-1 text-sm font-black">
                {band.label}
              </span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(evaluation.breakdown || []).map((item) => (
              <div key={item.category} className="rounded-2xl border border-slate-200 p-4">
                <p className="text-sm font-bold text-slate-800">{item.label_vi}</p>
                <p className="mt-2 text-xl font-black text-slate-950">
                  {item.earned}/{item.max_score}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {item.matched}/{item.total} tiêu chí khớp
                </p>
              </div>
            ))}
          </div>

          {(evaluation.issues || []).length ? (
            <div className="space-y-4">
              {(evaluation.issues || []).map((issue) => (
                <article key={issue.id} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                  <h3 className="font-black text-amber-950">Cần xem lại: {issue.label_vi}</h3>
                  <p className="mt-1 text-xs text-amber-800">
                    Mở gợi ý theo thứ tự để khoanh vùng mà không tải trước đáp án.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[0, 1, 2, 3, 4].map((level) => {
                      const state = getStudentHintLevelState(revealedLevels, issue.id, level);
                      return (
                        <button
                          key={level}
                          type="button"
                          disabled={state.state === "locked" || loading}
                          onClick={() => onRevealHint(issue.id, level)}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold ${
                            state.state === "revealed"
                              ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                              : state.state === "available"
                                ? "border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                                : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                          }`}
                        >
                          {state.state === "locked" ? <LockKeyhole size={13} /> : <Lightbulb size={13} />}
                          Cấp {level}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 space-y-2" aria-live="polite">
                    {Object.entries(revealedHints[issue.id] || {})
                      .sort(([left], [right]) => Number(left) - Number(right))
                      .map(([level, hint]) => (
                        <p key={level} className="rounded-xl bg-white px-3 py-2 text-sm leading-6 text-slate-700">
                          <strong>Cấp {level}:</strong> {hint.text_vi}
                        </p>
                      ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800">
              Không có nhóm tiêu chí sai trong lần chấm này.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-6 rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
          Bài làm hiện tại lấy từ mapping, phân loại và các ô bạn đã chỉnh. Chưa có nội
          dung gợi ý nào được tải vào trình duyệt.
        </p>
      )}

      {history.length > 0 && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
            Lịch sử revision
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {history.slice(0, 8).map((item) => (
              <span key={item.id || item.revision} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                {formatStudentAttemptRevision(item)} · {item.score}/100
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
