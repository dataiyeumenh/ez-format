import { useEffect, useId, useState } from "react";
import { Scissors } from "lucide-react";
import FieldProvenanceBadge from "./FieldProvenanceBadge";
import { fieldDisplayValue } from "../../utils/reconstruction";

const HEADER_FIELDS = [
  ["invoice_number", "Số hóa đơn"],
  ["invoice_symbol", "Ký hiệu"],
  ["invoice_date", "Ngày hóa đơn"],
  ["posting_date", "Ngày hạch toán"],
  ["supplier_code", "Mã nhà cung cấp"],
  ["supplier_tax_code", "MST nhà cung cấp"],
  ["supplier_name", "Tên nhà cung cấp"],
  ["customer_code", "Mã khách hàng"],
  ["customer_name", "Tên khách hàng"],
  ["payment_method", "Phương thức thanh toán"],
];

const LINE_FIELDS = [
  ["item_code", "Mã"],
  ["item_name", "Tên hàng/dịch vụ"],
  ["unit", "ĐVT"],
  ["quantity", "Số lượng"],
  ["unit_price", "Đơn giá"],
  ["amount", "Thành tiền"],
  ["vat_rate", "VAT %"],
  ["vat_amount", "Tiền VAT"],
  ["inventory_account", "TK kho/chi phí"],
  ["payable_account", "TK công nợ/tiền"],
  ["debit_account", "TK nợ"],
  ["credit_account", "TK có"],
];

const CATALOG_TYPES = {
  supplier_code: "supplier",
  customer_code: "customer",
  item_code: "item",
  unit: "unit",
  inventory_account: "account",
  payable_account: "account",
  debit_account: "account",
  credit_account: "account",
};

function CatalogInput({
  value,
  onChange,
  onSave,
  catalogType,
  onSearchCatalog,
  ariaLabel,
  className,
}) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    if (!catalogType || !onSearchCatalog || !value.trim()) {
      setSuggestions([]);
      return undefined;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      onSearchCatalog(catalogType, value)
        .then((items) => {
          if (active) setSuggestions(items || []);
        })
        .catch(() => {
          if (active) setSuggestions([]);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalogType, onSearchCatalog, value]);
  return (
    <>
      <input
        aria-label={ariaLabel}
        type="text"
        value={value}
        list={catalogType ? listId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
        className={className}
      />
      {catalogType && (
        <datalist id={listId}>
          {suggestions.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name || item.taxCode || item.code}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}

function EditableField({ field, name, label, onSave, onSearchCatalog }) {
  const [value, setValue] = useState(fieldDisplayValue(field));
  useEffect(() => setValue(fieldDisplayValue(field)), [field]);
  return (
    <label className="block rounded-xl border border-gray-200 bg-white p-3">
      <span className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">
        {label}
        <FieldProvenanceBadge field={field} />
      </span>
      <CatalogInput
        value={value}
        onChange={setValue}
        onSave={() => {
          if (value !== fieldDisplayValue(field)) onSave(value);
        }}
        catalogType={CATALOG_TYPES[name]}
        onSearchCatalog={onSearchCatalog}
        ariaLabel={label}
        className="mt-2 w-full border-0 bg-transparent p-0 text-sm font-semibold text-gray-900 outline-none focus:ring-0"
      />
    </label>
  );
}

function EditableLineField({ field, name, label, sourceRow, onSave, onSearchCatalog }) {
  const [value, setValue] = useState(fieldDisplayValue(field));
  useEffect(() => setValue(fieldDisplayValue(field)), [field]);
  return (
    <CatalogInput
      value={value}
      onChange={setValue}
      onSave={() => {
        if (value !== fieldDisplayValue(field)) onSave(value);
      }}
      catalogType={CATALOG_TYPES[name]}
      onSearchCatalog={onSearchCatalog}
      ariaLabel={`${label}, dòng nguồn ${sourceRow}`}
      className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 outline-none hover:border-gray-200 focus:border-primary-400 focus:bg-white"
    />
  );
}

export default function VoucherReviewWorkspace({
  draft,
  onUpdate,
  onSplit,
  onSearchCatalog,
}) {
  const [selectedRows, setSelectedRows] = useState([]);
  useEffect(() => setSelectedRows([]), [draft?.id]);
  if (!draft) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Chọn một chứng từ để kiểm tra.
      </div>
    );
  }

  const saveHeader = (name, value) =>
    onUpdate(draft, [{ op: "set_field", path: `header.${name}`, value }]);
  const saveLine = (line, name, value) =>
    onUpdate(draft, [
      { op: "set_field", path: `lines.${line.id}.fields.${name}`, value },
    ]);

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary-600">
            Chứng từ tái tạo
          </p>
          <h3 className="mt-1 text-xl font-black text-gray-900">
            {draft.header?.invoice_number?.value || "Chưa có số hóa đơn"}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            Nguồn dòng: {draft.source_rows.join(", ")}
          </p>
        </div>
        <select
          aria-label="Loại chứng từ"
          value={`${draft.direction}_${draft.nature === "service" ? "services" : draft.nature}`}
          onChange={(event) =>
            onUpdate(draft, [{ op: "set_type", value: event.target.value }])
          }
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-800"
        >
          <option value="purchase_goods">Mua hàng hóa</option>
          <option value="purchase_services">Mua dịch vụ</option>
          <option value="sales_goods">Bán hàng hóa</option>
          <option value="sales_services">Bán dịch vụ</option>
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {HEADER_FIELDS.filter(([name]) => draft.header?.[name]).map(([name, label]) => (
          <EditableField
            key={name}
            field={draft.header[name]}
            name={name}
            label={label}
            onSave={(value) => saveHeader(name, value)}
            onSearchCatalog={onSearchCatalog}
          />
        ))}
      </div>

      {draft.issues?.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          {draft.issues.map((issue, index) => (
            <div key={`${issue.code}-${index}`} className="text-sm text-amber-950">
              <strong>{issue.code}:</strong> {issue.message}
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-gray-200">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
          <div>
            <h4 className="text-sm font-black text-gray-900">Dòng chi tiết</h4>
            <p className="text-xs text-gray-500">
              Chọn một phần dòng để tách thành chứng từ mới.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-xs"
            disabled={
              !selectedRows.length || selectedRows.length === draft.lines.length
            }
            onClick={() => onSplit(draft, selectedRows)}
          >
            <Scissors size={14} /> Tách {selectedRows.length || ""} dòng
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] text-sm">
            <thead className="bg-white text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Chọn</th>
                {LINE_FIELDS.map(([, label]) => (
                  <th key={label} className="px-3 py-2 text-left">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((line) => {
                const sourceRow = line.source_rows[0];
                return (
                  <tr key={line.id} className="border-t border-gray-100 align-top">
                    <td className="px-3 py-3">
                      <input
                        aria-label={`Chọn dòng nguồn ${sourceRow} để tách`}
                        type="checkbox"
                        checked={selectedRows.includes(sourceRow)}
                        onChange={(event) =>
                          setSelectedRows((current) =>
                            event.target.checked
                              ? [...current, sourceRow]
                              : current.filter((row) => row !== sourceRow),
                          )
                        }
                      />
                    </td>
                    {LINE_FIELDS.map(([name, label]) => (
                      <td key={name} className="min-w-[120px] px-3 py-2">
                        <EditableLineField
                          key={`${line.id}-${name}-${draft.revision}`}
                          field={line.fields?.[name]}
                          name={name}
                          label={label}
                          sourceRow={sourceRow}
                          onSave={(value) => saveLine(line, name, value)}
                          onSearchCatalog={onSearchCatalog}
                        />
                        <div className="mt-1">
                          <FieldProvenanceBadge field={line.fields?.[name]} />
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
