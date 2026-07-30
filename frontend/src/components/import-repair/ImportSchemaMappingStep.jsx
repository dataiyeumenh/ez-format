import { CheckCircle2, Loader2 } from "lucide-react";

const COLUMN_ROLES = [
  { key: "technical_message", label: "Cột thông báo MISA", required: true },
  { key: "source_row_number", label: "Cột số dòng nguồn" },
  { key: "document_number", label: "Cột số chứng từ" },
  { key: "invoice_number", label: "Cột số hóa đơn" },
  { key: "document_date", label: "Cột ngày chứng từ" },
  { key: "partner_code", label: "Cột mã đối tượng" },
  { key: "item_code", label: "Cột mã hàng" },
  { key: "amount", label: "Cột số tiền" },
];

const ImportSchemaMappingStep = ({ inspection, loading, onSubmit }) => {
  const headers = inspection?.headers || [];
  const needsMapping = inspection?.status === "needs_schema_mapping";

  const handleSubmit = (event) => {
    event.preventDefault();
    const columns = Object.fromEntries(
      COLUMN_ROLES.map(({ key }) => [
        key,
        event.currentTarget.elements.namedItem(key)?.value || "",
      ]).filter(([, value]) => value),
    );
    onSubmit({
      expected_version: inspection?.version,
      sheet_name: inspection?.sheetName,
      header_row: inspection?.headerRow,
      columns,
    });
  };

  if (!inspection) {
    return <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Tải file lỗi để bắt đầu ghép cột.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm font-bold text-slate-900">Ghép cột thông báo kỹ thuật</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Chỉ cột thông báo MISA là bắt buộc. Ghép thêm các cột định vị có trong file
          để tìm chứng từ chính xác hơn; dữ liệu không được tự suy đoán.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {COLUMN_ROLES.map((role) => (
            <div key={role.key}>
              <label
                htmlFor={`repair-${role.key}`}
                className="block text-sm font-semibold text-slate-700"
              >
                {role.label}{role.required ? " *" : " (không bắt buộc)"}
              </label>
              <select
                id={`repair-${role.key}`}
                name={role.key}
                defaultValue={inspection?.columns?.[role.key] || ""}
                className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800"
                required={role.required}
                disabled={!needsMapping || loading}
              >
                <option value="">Chọn cột</option>
                {headers.map((header) => <option key={header} value={header}>{header}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
      <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={!needsMapping || loading}>
        {loading ? <Loader2 size={17} className="animate-spin" /> : <CheckCircle2 size={17} />}
        Xác nhận ghép cột
      </button>
    </form>
  );
};

export default ImportSchemaMappingStep;
