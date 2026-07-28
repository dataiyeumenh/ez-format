import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  ServerOff,
} from "lucide-react";
import { getProfilePresentation } from "../../utils/converterOperations.js";

export default function MappingProfileV2Card({
  profileMatch = null,
  serviceOnline = true,
  busy = false,
  onUse,
}) {
  const [showDrift, setShowDrift] = useState(false);
  const presentation = getProfilePresentation(profileMatch);
  const profile = profileMatch?.profile || profileMatch || {};
  const drift = Array.isArray(profileMatch?.drift) ? profileMatch.drift : [];
  const approvedRiskFields = Array.isArray(profileMatch?.approved_risk_flags)
    ? profileMatch.approved_risk_flags
    : [];
  const unapprovedRiskFields = Array.isArray(profileMatch?.unapproved_risk_flags)
    ? profileMatch.unapproved_risk_flags
    : profileMatch?.approval_applies_to_match
      ? []
      : profileMatch?.risk_flags || profile.risk_flags || [];
  const mappingSourceLabel =
    {
      profile_v2: "Mapping Profile V2",
      heuristic: "Heuristic",
      profile: "Mapping Profile V1",
      mixed: "Kết hợp profile và heuristic",
    }[presentation.actualMappingSource] || "Chưa xác định";

  if (!profileMatch) {
    return (
      <section
        aria-label="Mapping Profile V2"
        className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 p-4"
      >
        <div className="flex items-start gap-3">
          <Database className="mt-0.5 text-slate-400" size={19} />
          <div>
            <h3 className="text-sm font-bold text-slate-800">{presentation.label}</h3>
            <p className="mt-1 text-sm text-slate-600">
              EzFormat sẽ tạo mapping mới; bạn vẫn kiểm tra trước khi dùng.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="mapping-profile-title"
      className={`rounded-2xl border p-4 shadow-sm ${
        presentation.requiresReview
          ? "border-amber-200 bg-amber-50/70"
          : "border-blue-100 bg-gradient-to-br from-white to-blue-50/70"
      }`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {presentation.requiresReview ? (
              <AlertTriangle className="text-amber-600" size={18} />
            ) : (
              <CheckCircle2 className="text-emerald-600" size={18} />
            )}
            <h3
              id="mapping-profile-title"
              className="text-sm font-black text-slate-900"
            >
              Mapping cho nguồn này
            </h3>
          </div>
          <p className="mt-2 truncate text-base font-bold text-slate-900">
            {profile.name || profile.source_family || "Setting đã xác nhận"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            {[profile.document_type, profile.target_template_label, profile.version]
              .filter(Boolean)
              .join(" · ") || "Đúng phạm vi người dùng và template hiện tại"}
          </p>
          <p
            className={`mt-2 text-sm font-semibold ${
              presentation.requiresReview ? "text-amber-800" : "text-emerald-700"
            }`}
          >
            {presentation.label}
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-600">
            Nguồn mapping thực tế: {mappingSourceLabel}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary w-full shrink-0 sm:w-auto"
          disabled={busy || !presentation.canUseProfile || !serviceOnline}
          onClick={onUse}
        >
          {busy
            ? "Đang áp dụng…"
            : presentation.canUseProfile
              ? "Dùng profile và xem trước"
              : "Profile chỉ để xem"}
        </button>
      </div>

      {!serviceOnline && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-white/80 p-3 text-sm text-slate-700">
          <ServerOff className="mt-0.5 shrink-0 text-amber-600" size={16} />
          Dịch vụ profile đang gián đoạn. Mapping hiện tại vẫn dùng được nhưng không lưu
          lâu dài.
        </div>
      )}

      {(drift.length > 0 ||
        approvedRiskFields.length > 0 ||
        unapprovedRiskFields.length > 0) && (
        <div className="mt-4 border-t border-amber-200/70 pt-3">
          <div className="mb-1 flex flex-wrap gap-2 text-xs font-bold">
            {approvedRiskFields.length > 0 && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800">
                {approvedRiskFields.length} trường rủi ro đã phê duyệt
              </span>
            )}
            {unapprovedRiskFields.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-900">
                {unapprovedRiskFields.length} trường rủi ro chưa phê duyệt
              </span>
            )}
          </div>
          <button
            type="button"
            aria-expanded={showDrift}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-amber-900 hover:bg-amber-100 focus-visible:ring-amber-500"
            onClick={() => setShowDrift((value) => !value)}
          >
            Xem thay đổi và rủi ro
            <ChevronDown
              size={16}
              className={`transition-transform ${showDrift ? "rotate-180" : ""}`}
            />
          </button>
          {showDrift && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-amber-200 bg-white">
              <table className="min-w-[620px] w-full text-left text-sm">
                <thead className="bg-amber-50 text-xs uppercase tracking-wide text-amber-900">
                  <tr>
                    <th className="px-3 py-2">Trường cũ</th>
                    <th className="px-3 py-2">File hiện tại</th>
                    <th className="px-3 py-2">Hành động đề xuất</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.map((item, index) => (
                    <tr key={item.id || index} className="border-t border-amber-100">
                      <td className="px-3 py-2">
                        {item.old_field || item.previous || "—"}
                      </td>
                      <td className="px-3 py-2 font-semibold">
                        {item.current_field || item.current || "—"}
                      </td>
                      <td className="px-3 py-2">
                        {item.suggestion || "Cần người dùng xác nhận"}
                      </td>
                    </tr>
                  ))}
                  {approvedRiskFields.map((field, index) => (
                    <tr
                      key={`approved-risk-${index}`}
                      className="border-t border-amber-100"
                    >
                      <td className="px-3 py-2" colSpan={2}>
                        {field.field || field}
                      </td>
                      <td className="px-3 py-2 font-semibold text-emerald-700">
                        Đã phê duyệt rõ ràng; vẫn bắt buộc xem trước
                      </td>
                    </tr>
                  ))}
                  {unapprovedRiskFields.map((field, index) => (
                    <tr
                      key={`unapproved-risk-${index}`}
                      className="border-t border-amber-100"
                    >
                      <td className="px-3 py-2" colSpan={2}>
                        {field.field || field}
                      </td>
                      <td className="px-3 py-2 font-semibold text-amber-800">
                        Không tự áp dụng trường rủi ro cao
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
