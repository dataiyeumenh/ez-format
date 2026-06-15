const SEVERITY_CLASS = {
  fatal: "bg-red-100 text-red-700",
  blocker: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-blue-100 text-blue-700",
};

export default function ValidationIssueTable({ issues = [] }) {
  if (!issues.length) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <h3 className="text-base font-bold text-gray-900">Chi tiết lỗi/cảnh báo</h3>
        <p className="text-xs text-gray-500">
          Backend là nguồn kiểm tra chính. AI không được thay đổi mức độ lỗi.
        </p>
      </div>
      <div className="overflow-auto">
        <table className="min-w-[980px] text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Mức độ</th>
              <th className="px-4 py-3 text-left">Dòng</th>
              <th className="px-4 py-3 text-left">Cột</th>
              <th className="px-4 py-3 text-left">Lỗi</th>
              <th className="px-4 py-3 text-left">Hiện tại</th>
              <th className="px-4 py-3 text-left">Kỳ vọng</th>
              <th className="px-4 py-3 text-left">Nguồn</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, index) => (
              <tr key={`${issue.code}-${index}`} className="border-t border-gray-100 align-top">
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                      SEVERITY_CLASS[issue.severity] || SEVERITY_CLASS.info
                    }`}
                  >
                    {issue.severity}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{issue.row ?? "—"}</td>
                <td className="px-4 py-3 font-medium text-gray-800">{issue.field || "—"}</td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-gray-900">{issue.message}</div>
                  {issue.explanation && (
                    <details className="mt-2 text-xs text-gray-500">
                      <summary className="cursor-pointer font-semibold text-primary-700">
                        Vì sao / cách sửa
                      </summary>
                      <div className="mt-2 space-y-1 leading-relaxed">
                        <p><strong>Vì sao:</strong> {issue.explanation.why}</p>
                        <p><strong>Ảnh hưởng:</strong> {issue.explanation.impact}</p>
                        <p><strong>Cách sửa:</strong> {issue.explanation.fix}</p>
                      </div>
                    </details>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{issue.actual ?? "—"}</td>
                <td className="px-4 py-3 text-gray-600">{issue.expected ?? "—"}</td>
                <td className="px-4 py-3">
                  {issue.source_url ? (
                    <a
                      className="font-semibold text-primary-600 hover:underline"
                      href={issue.source_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Mở nguồn
                    </a>
                  ) : (
                    <span className="text-gray-400">Rule nội bộ</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

