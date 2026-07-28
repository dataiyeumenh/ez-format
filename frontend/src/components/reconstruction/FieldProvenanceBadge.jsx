const SOURCE_LABELS = {
  source_direct: "Từ file",
  source_fill_down: "Điền theo chứng từ",
  workspace_master_data: "Danh mục MISA",
  confirmed_alias: "Alias đã xác nhận",
  approved_profile: "Cấu hình đã lưu",
  deterministic_derived: "Tính tự động",
  ai_suggestion: "AI gợi ý",
  manual: "Đã sửa thủ công",
};

const TRUST_STYLES = {
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  supported: "bg-blue-50 text-blue-700 ring-blue-200",
  suggested: "bg-amber-50 text-amber-800 ring-amber-200",
  missing: "bg-gray-100 text-gray-600 ring-gray-200",
  conflict: "bg-red-50 text-red-700 ring-red-200",
};

export default function FieldProvenanceBadge({ field }) {
  const source = field?.provenance?.[0]?.source;
  const label = SOURCE_LABELS[source] || "Chưa có nguồn";
  const trust = field?.trust || "missing";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${TRUST_STYLES[trust] || TRUST_STYLES.missing}`}
      title={field?.provenance?.[0]?.note || label}
    >
      {label}
    </span>
  );
}
