export const VALIDATION_PAGE_SIZE = 25;

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

export function summarizeValidationIssues(issues = []) {
  return issues.reduce(
    (summary, issue) => {
      summary.all += 1;
      if (["blocker", "warning", "info"].includes(issue.severity)) {
        summary[issue.severity] += 1;
      }
      return summary;
    },
    { all: 0, blocker: 0, warning: 0, info: 0 },
  );
}

export function filterValidationIssues(
  issues = [],
  { severity = "all", query = "" } = {},
) {
  const queryTokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return issues.filter((issue) => {
    if (severity !== "all" && issue.severity !== severity) return false;
    if (!queryTokens.length) return true;
    const searchable = normalizeSearchText(
      [
        issue.row,
        issue.field,
        issue.invoice,
        issue.message,
        issue.actual,
        issue.expected,
        issue.fix_hint,
        issue.code,
      ].join(" "),
    );
    return queryTokens.every((token) => searchable.includes(token));
  });
}

export function paginateValidationIssues(
  issues = [],
  requestedPage = 0,
  pageSize = VALIDATION_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Number(pageSize) || VALIDATION_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(issues.length / safePageSize));
  const page = Math.min(
    totalPages - 1,
    Math.max(0, Math.trunc(Number(requestedPage) || 0)),
  );
  const offset = page * safePageSize;
  const items = issues.slice(offset, offset + safePageSize);
  return {
    items,
    page,
    totalPages,
    total: issues.length,
    start: issues.length ? offset + 1 : 0,
    end: offset + items.length,
  };
}
