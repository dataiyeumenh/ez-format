const SEVERITY_LABELS = {
  blocker: "Cần sửa",
  warning: "Cảnh báo",
  info: "Thông tin",
};

const SEVERITY_CLASSES = {
  blocker: "bg-red-50 text-red-700 ring-red-100",
  warning: "bg-amber-50 text-amber-700 ring-amber-100",
  info: "bg-blue-50 text-blue-700 ring-blue-100",
};

function display(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function ValidationIssueTable({ issues = [] }) {
  if (!issues.length) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
        <h3 className="text-base font-black text-gray-900">Chi tiết lỗi/cảnh báo</h3>
        <p className="mt-1 text-sm text-gray-500">
          Bảng này giúp bạn biết dòng/cột nào cần sửa hoặc rà soát trước khi import vào
          MISA.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[980px] text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Mức độ</th>
              <th className="px-4 py-3 text-left">Dòng</th>
              <th className="px-4 py-3 text-left">Cột</th>
              <th className="px-4 py-3 text-left">Nội dung</th>
              <th className="px-4 py-3 text-left">Hiện tại</th>
              <th className="px-4 py-3 text-left">Kỳ vọng</th>
              <th className="px-4 py-3 text-left">Cách sửa</th>
              <th className="px-4 py-3 text-left">Nguồn</th>
            </tr>
          </thead>
          <tbody>
            {issues.slice(0, 200).map((issue, index) => (
              <tr
                key={`${issue.code || "issue"}-${index}`}
                className="border-t border-gray-100 align-top"
              >
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${
                      SEVERITY_CLASSES[issue.severity] || SEVERITY_CLASSES.info
                    }`}
                  >
                    {SEVERITY_LABELS[issue.severity] || issue.severity}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{display(issue.row)}</td>
                <td className="px-4 py-3 font-semibold text-gray-800">
                  {display(issue.field)}
                </td>
                <td className="px-4 py-3 text-gray-800">
                  <div>{display(issue.message)}</div>
                  {issue.invoice && (
                    <div className="mt-1 text-xs text-gray-500">
                      Chứng từ: {issue.invoice}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{display(issue.actual)}</td>
                <td className="px-4 py-3 text-gray-600">{display(issue.expected)}</td>
                <td className="px-4 py-3 text-gray-700">{display(issue.fix_hint)}</td>
                <td className="px-4 py-3">
                  {issue.source_url ? (
                    <a
                      href={issue.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-primary-600 hover:underline"
                    >
                      Xem nguồn
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {issues.length > 200 && (
        <p className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
          Đang hiển thị 200 mục đầu tiên trong tổng {issues.length} mục.
        </p>
      )}
    </section>
  );
}
