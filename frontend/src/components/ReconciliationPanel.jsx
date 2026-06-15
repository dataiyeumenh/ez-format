export default function ReconciliationPanel({ reconciliation }) {
  if (!reconciliation) return null;

  const items = [
    ["Dòng nguồn", reconciliation.input_rows],
    ["Dòng MISA", reconciliation.output_rows],
    ["Số chứng từ", reconciliation.invoice_count ?? "—"],
    ["Tổng thành tiền", reconciliation.sum_amount ?? "—"],
    ["Tổng thuế", reconciliation.sum_vat ?? "—"],
    ["Tổng thanh toán", reconciliation.sum_total ?? "—"],
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-bold text-gray-900">Đối chiếu nhanh</h3>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-gray-50 p-3">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="mt-1 truncate text-sm font-black text-gray-900" title={String(value)}>
              {value}
            </div>
          </div>
        ))}
      </div>
      {reconciliation.unmapped_columns?.length > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          {reconciliation.unmapped_columns.length} cột nguồn chưa dùng trong mapping.
        </p>
      )}
    </section>
  );
}

