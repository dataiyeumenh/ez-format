const SKILL_LABELS = {
  excel_mapping: "Mapping Excel",
  document_classification: "Phân loại chứng từ",
  vat_reconciliation: "Đối chiếu VAT",
  misa_template_readiness: "Sẵn sàng mẫu MISA",
};

export default function SkillProgressCard({ progress = {} }) {
  const skills = Object.entries(progress.skills || {});
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
        Tiến độ kỹ năng đã kiểm chứng
      </p>
      {skills.length ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {skills.map(([skill, value]) => (
            <div key={skill} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-bold text-slate-800">
                  {SKILL_LABELS[skill] || skill}
                </span>
                <span className="text-sm font-black text-primary-700">
                  {Number(value.score || 0).toLocaleString("vi-VN")} điểm
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {Number(value.evidenceCount || 0).toLocaleString("vi-VN")} bằng chứng
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          Chưa có đánh giá deterministic hoàn tất.
        </p>
      )}
    </section>
  );
}
