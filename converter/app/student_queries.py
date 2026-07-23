from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable

from app.excel_io import InputTable
from app.parsing import parse_decimal
from app.student_field_dictionary import field_definition
from app.student_models import StudentAnswer, StudentAnswerEvidence


MAX_ANSWER_EVIDENCE = 20
_DOCUMENT_TERMS = ("ma hoa don", "so hoa don", "so chung tu", "so phieu nhap")
_UNSUPPORTED_PATTERNS = (
    "duoc khau tru",
    "duoc tru khi tinh thue",
    "dung luat",
    "hop le khong",
    "chac chan",
    "nen hach toan",
    "tai khoan nao",
    "dung tai khoan",
)


def answer_question(question: str, session_state: dict[str, Any]) -> StudentAnswer:
    normalized_question = _normalize(question)
    if not normalized_question:
        return _unsupported(
            "unsupported_legal_or_business_judgment",
            "Câu hỏi đang trống nên chưa thể truy vấn file.",
            "empty_question",
        )

    intent = _classify_intent(normalized_question)
    handlers: dict[str, Callable[[str, dict[str, Any]], StudentAnswer]] = {
        "file_summary": _answer_file_summary,
        "locate_column": _answer_locate_column,
        "locate_rows": _answer_locate_rows,
        "explain_mapping": _answer_explain_mapping,
        "explain_issue": _answer_explain_issue,
        "aggregate_amount": _answer_aggregate_amount,
        "count_documents": _answer_count_documents,
        "find_duplicates": _answer_find_duplicates,
        "find_vat_mismatches": _answer_find_vat_mismatches,
        "required_actions_before_export": _answer_required_actions,
        "concept_explanation": _answer_concept,
        "unsupported_legal_or_business_judgment": _answer_unsupported_judgment,
    }
    if intent is None:
        if not bool(session_state.get("ai_available")):
            return _unsupported(
                "unsupported_legal_or_business_judgment",
                "Câu hỏi chưa khớp truy vấn deterministic và AI bổ sung hiện không khả dụng.",
                "ai_unavailable",
                outcome="ai_unavailable",
            )
        return _unsupported(
            "unsupported_legal_or_business_judgment",
            "Câu hỏi này chưa thuộc nhóm truy vấn file được hỗ trợ.",
            "unsupported_question",
        )

    answer = handlers[intent](normalized_question, session_state)
    if answer.outcome == "supported":
        validate_answer_evidence(answer, session_state)
    return answer


def validate_answer_evidence(
    answer: StudentAnswer,
    session_state: dict[str, Any],
) -> None:
    table = _table(session_state)
    headers = set(table.headers)
    target_headers = set(str(item) for item in session_state.get("target_headers") or [])
    first_data_row = table.header_row_index + 2
    last_data_row = first_data_row + len(table.rows) - 1
    sheet_name = str(table.sheet_name or "")
    issues = list((session_state.get("readiness") or {}).get("issues") or [])

    if answer.outcome == "supported" and not answer.evidence:
        raise ValueError("answer evidence is required")
    if answer.evidence_count < len(answer.evidence):
        raise ValueError("answer evidence count is invalid")

    for evidence in answer.evidence:
        expected_id = _evidence_id(
            session_state,
            evidence.kind,
            evidence.sheet,
            evidence.row,
            evidence.field,
            evidence.target_field,
            evidence.issue_code,
        )
        if evidence.id != expected_id:
            raise ValueError("answer evidence id is invalid")
        if evidence.sheet != sheet_name:
            raise ValueError("answer evidence sheet is invalid")

        if evidence.kind == "source_column":
            if evidence.field not in headers or evidence.row is not None:
                raise ValueError("answer evidence column is invalid")
            if evidence.actual is not None or evidence.expected is not None:
                raise ValueError("answer evidence column values are invalid")
            continue

        if evidence.kind == "template":
            if evidence.target_field not in target_headers or evidence.row is not None:
                raise ValueError("answer evidence template field is invalid")
            continue

        if evidence.field not in headers:
            raise ValueError("answer evidence field is invalid")
        if evidence.row is None or not first_data_row <= evidence.row <= last_data_row:
            raise ValueError("answer evidence row is invalid")
        data_row_number = evidence.row - table.header_row_index - 1
        source_row = table.rows[data_row_number - 1]

        if evidence.kind == "source_cell":
            if evidence.actual != _json_value(source_row.get(evidence.field)):
                raise ValueError("answer evidence value is invalid")
            if evidence.expected is not None:
                raise ValueError("answer evidence expected value is invalid")
            continue

        matching_issue = next(
            (
                issue
                for issue in issues
                if str(issue.get("code") or "") == str(evidence.issue_code or "")
                and int(issue.get("row") or 0) == data_row_number
                and str(issue.get("field") or "") == str(evidence.target_field or "")
            ),
            None,
        )
        if matching_issue is None:
            raise ValueError("answer evidence issue is invalid")
        if evidence.actual != _json_value(matching_issue.get("actual")):
            raise ValueError("answer evidence issue actual is invalid")
        if evidence.expected != _json_value(matching_issue.get("expected")):
            raise ValueError("answer evidence issue expected is invalid")


def _classify_intent(question: str) -> str | None:
    if any(pattern in question for pattern in _UNSUPPORTED_PATTERNS):
        return "unsupported_legal_or_business_judgment"
    if any(
        pattern in question
        for pattern in (
            "can sua gi",
            "can xu ly gi",
            "bat buoc lam",
            "truoc khi export",
            "truoc khi xuat",
            "truoc khi import",
            "cac buoc can lam",
        )
    ):
        return "required_actions_before_export"
    if (
        "giai thich" in question
        and any(term in question for term in ("loi", "blocker", "canh bao", "vi sao"))
    ) or ("vi sao" in question and any(term in question for term in ("loi", "blocker", "canh bao"))):
        return "explain_issue"
    if "trung" in question:
        return "find_duplicates"
    if any(term in question for term in ("vat", "thue gtgt", "tien thue")) and any(
        term in question for term in ("lech", "khong khop", "loi", "chenh lech")
    ):
        return "find_vat_mismatches"
    if any(
        pattern in question
        for pattern in ("bao nhieu hoa don", "dem so chung tu", "bao nhieu chung tu")
    ):
        return "count_documents"
    if "tong quan" in question or "tom tat" in question or "tinh trang file" in question:
        return "file_summary"
    if "file" in question and ("bao nhieu dong" in question or "co gi" in question):
        return "file_summary"
    if any(term in question for term in ("mapping", " map ", "map vao", "ghep sang", "dua vao dau")):
        return "explain_mapping"
    if "cot" in question and any(
        term in question for term in ("nam o dau", "tim cot", "la cot nao", "co cot")
    ):
        return "locate_column"
    if "dong" in question and any(
        term in question for term in ("nhung dong", "tim", "xuat hien", "o dong", "dong nao", "nam o")
    ):
        return "locate_rows"
    if any(term in question for term in ("tinh tong", "cong cot", "cong tien", "tong thanh tien", "tong thanh toan", "tong so luong", "tong don gia")):
        return "aggregate_amount"
    if any(term in question for term in ("y nghia gi", "khai niem", "dung de lam gi")):
        return "concept_explanation"
    return None


def _answer_file_summary(question: str, state: dict[str, Any]) -> StudentAnswer:
    table = _table(state)
    if not table.rows or not table.headers:
        return _unsupported("file_summary", "File không có dòng dữ liệu để trích dẫn.", "no_evidence")
    summary = state.get("summary") or {}
    row_count = int(summary.get("data_row_count") or len(table.rows))
    document_count = summary.get("document_count")
    issue_counts = summary.get("issue_counts") or {}
    evidence = [_cell_evidence(state, 1, table.headers[0])]
    if len(table.rows) > 1:
        evidence.append(_cell_evidence(state, len(table.rows), table.headers[0]))
    document_text = (
        "chưa đủ dữ liệu để đếm chứng từ"
        if document_count is None
        else f"{int(document_count)} chứng từ ước tính"
    )
    return _supported(
        "file_summary",
        (
            f"File có {row_count} dòng dữ liệu, {document_text}, "
            f"{int(issue_counts.get('blocker') or 0)} lỗi chặn và "
            f"{int(issue_counts.get('warning') or 0)} cảnh báo."
        ),
        evidence,
    )


def _answer_locate_column(question: str, state: dict[str, Any]) -> StudentAnswer:
    header = _select_header(question, state)
    if header is None:
        return _unsupported("locate_column", "Không tìm thấy cột phù hợp trong file đang mở.", "no_evidence")
    evidence = [_column_evidence(state, header)]
    return _supported(
        "locate_column",
        f"Cột nguồn phù hợp là '{header}' trên sheet '{_table(state).sheet_name or ''}'.",
        evidence,
    )


def _answer_locate_rows(question: str, state: dict[str, Any]) -> StudentAnswer:
    table = _table(state)
    preferred_header = _select_header(question, state)
    search_headers = [preferred_header] if preferred_header else table.headers
    matches: list[tuple[int, str]] = []
    for row_number, row in enumerate(table.rows, start=1):
        for header in search_headers:
            value = row.get(header)
            normalized_value = _normalize(value)
            if len(normalized_value) >= 2 and normalized_value in question:
                matches.append((row_number, header))
                break
    if not matches:
        return _unsupported("locate_rows", "Không tìm thấy dòng khớp câu hỏi trong file.", "no_evidence")
    evidence = [_cell_evidence(state, row_number, header) for row_number, header in matches]
    return _supported(
        "locate_rows",
        f"Tìm thấy {len(matches)} dòng khớp trong file đang mở.",
        evidence,
        evidence_count=len(matches),
    )


def _answer_explain_mapping(question: str, state: dict[str, Any]) -> StudentAnswer:
    header = _select_header(question, state)
    mapping = state.get("mapping") or {}
    target_spec = mapping.get(header) if header else None
    if not header or not target_spec:
        return _unsupported(
            "explain_mapping",
            "Không có mapping deterministic phù hợp để giải thích.",
            "no_evidence",
        )
    targets = target_spec if isinstance(target_spec, list) else [target_spec]
    return _supported(
        "explain_mapping",
        f"Cột '{header}' đang được map vào {', '.join(str(item) for item in targets)}.",
        [_column_evidence(state, header, target_field=str(targets[0]))],
        answer_type="deterministic_explanation",
    )


def _answer_explain_issue(question: str, state: dict[str, Any]) -> StudentAnswer:
    issues = list((state.get("readiness") or {}).get("issues") or [])
    requested_worksheet_row = _requested_row(question)
    if requested_worksheet_row is not None:
        requested_data_row = _worksheet_data_row(state, requested_worksheet_row)
        if requested_data_row is None:
            return _unsupported(
                "explain_issue",
                "Dòng được hỏi là header hoặc nằm ngoài vùng dữ liệu đang hoạt động.",
                "row_out_of_range",
            )
        issues = [
            issue
            for issue in issues
            if int(issue.get("row") or 0) == requested_data_row
        ]
    elif "blocker" in question:
        issues = [issue for issue in issues if issue.get("severity") == "blocker"]
    if not issues:
        return _unsupported("explain_issue", "Không có issue phù hợp để giải thích.", "no_evidence")
    evidence = [_issue_evidence(state, issue) for issue in issues if issue.get("row")]
    evidence = [item for item in evidence if item is not None]
    if not evidence:
        return _unsupported("explain_issue", "Issue không có bằng chứng dòng để trích dẫn.", "no_evidence")
    return _supported(
        "explain_issue",
        f"Có {len(issues)} issue phù hợp. {str(issues[0].get('message') or '').strip()}",
        evidence,
        evidence_count=len(issues),
        answer_type="deterministic_explanation",
        rule_sources=_issue_sources(issues),
    )


def _answer_aggregate_amount(question: str, state: dict[str, Any]) -> StudentAnswer:
    header = _select_header(question, state, numeric_only=True)
    table = _table(state)
    if header is None:
        return _unsupported("aggregate_amount", "Không xác định được cột số cần cộng.", "no_evidence")
    total = Decimal("0")
    contributing_rows: list[int] = []
    for row_number, row in enumerate(table.rows, start=1):
        parsed = parse_decimal(row.get(header))
        if parsed is None:
            continue
        total += parsed
        contributing_rows.append(row_number)
    if not contributing_rows:
        return _unsupported("aggregate_amount", "Cột được hỏi không có giá trị số.", "no_evidence")
    evidence = [_cell_evidence(state, row_number, header) for row_number in contributing_rows]
    return _supported(
        "aggregate_amount",
        f"Tổng cột '{header}' là {_format_decimal(total)} trên {len(contributing_rows)} dòng có số.",
        evidence,
        evidence_count=len(contributing_rows),
    )


def _answer_count_documents(question: str, state: dict[str, Any]) -> StudentAnswer:
    header = _document_header(state)
    table = _table(state)
    if header is None:
        return _unsupported("count_documents", "Không xác định được cột chứng từ.", "no_evidence")
    first_rows: dict[str, int] = {}
    for row_number, row in enumerate(table.rows, start=1):
        value = str(row.get(header) or "").strip()
        if value:
            first_rows.setdefault(value, row_number)
    if not first_rows:
        return _unsupported("count_documents", "Cột chứng từ không có giá trị.", "no_evidence")
    evidence = [_cell_evidence(state, row_number, header) for row_number in first_rows.values()]
    return _supported(
        "count_documents",
        f"File có {len(first_rows)} chứng từ khác nhau theo cột '{header}'.",
        evidence,
        evidence_count=len(first_rows),
    )


def _answer_find_duplicates(question: str, state: dict[str, Any]) -> StudentAnswer:
    issues = _issues_by_code(state, "duplicate_document_key")
    if issues:
        evidence = [_issue_evidence(state, issue) for issue in issues]
        evidence = [item for item in evidence if item is not None]
        if not evidence:
            return _unsupported(
                "find_duplicates",
                "Các duplicate issue không có evidence hợp lệ trong bảng đang hoạt động.",
                "no_evidence",
            )
        return _supported(
            "find_duplicates",
            f"Có {len(issues)} dòng chứng từ trùng nhưng thông tin không thống nhất.",
            evidence,
            evidence_count=len(issues),
            rule_sources=_issue_sources(issues),
        )
    header = _document_header(state)
    if header is None:
        return _unsupported("find_duplicates", "Không có cột chứng từ để kiểm tra trùng.", "no_evidence")
    return _supported(
        "find_duplicates",
        "Không phát hiện duplicate_document_key trong readiness hiện tại.",
        [_column_evidence(state, header)],
    )


def _answer_find_vat_mismatches(question: str, state: dict[str, Any]) -> StudentAnswer:
    issues = _issues_by_code(state, "vat_amount_mismatch")
    if issues:
        evidence = [_issue_evidence(state, issue) for issue in issues]
        evidence = [item for item in evidence if item is not None]
        if not evidence:
            return _unsupported(
                "find_vat_mismatches",
                "Các VAT issue không có evidence hợp lệ trong bảng đang hoạt động.",
                "no_evidence",
            )
        return _supported(
            "find_vat_mismatches",
            f"Có {len(issues)} dòng có tiền thuế GTGT không khớp.",
            evidence,
            evidence_count=len(issues),
            rule_sources=_issue_sources(issues),
        )
    header = _select_header("tien thue gtgt", state)
    if header is None:
        return _unsupported("find_vat_mismatches", "Không có cột tiền thuế để kiểm tra.", "no_evidence")
    return _supported(
        "find_vat_mismatches",
        "Không phát hiện vat_amount_mismatch trong readiness hiện tại.",
        [_column_evidence(state, header)],
    )


def _answer_required_actions(question: str, state: dict[str, Any]) -> StudentAnswer:
    issues = list((state.get("readiness") or {}).get("issues") or [])
    actionable = [issue for issue in issues if issue.get("severity") in {"blocker", "warning"}]
    if actionable:
        evidence = [_issue_evidence(state, issue) for issue in actionable if issue.get("row")]
        evidence = [item for item in evidence if item is not None]
        if not evidence:
            return _unsupported(
                "required_actions_before_export",
                "Các action hiện tại không có bằng chứng dòng để trích dẫn.",
                "no_evidence",
            )
        blockers = sum(issue.get("severity") == "blocker" for issue in actionable)
        warnings = sum(issue.get("severity") == "warning" for issue in actionable)
        return _supported(
            "required_actions_before_export",
            f"Cần xử lý {blockers} lỗi chặn và rà soát {warnings} cảnh báo trước khi export.",
            evidence,
            evidence_count=len(actionable),
            rule_sources=_issue_sources(actionable),
        )
    table = _table(state)
    if not table.headers:
        return _unsupported(
            "required_actions_before_export",
            "Không có evidence để xác nhận trạng thái export.",
            "no_evidence",
        )
    return _supported(
        "required_actions_before_export",
        "Readiness hiện tại không có blocker hoặc warning, nhưng vẫn cần đối chiếu nghiệp vụ.",
        [_column_evidence(state, table.headers[0])],
    )


def _answer_concept(question: str, state: dict[str, Any]) -> StudentAnswer:
    header = _select_header(question, state)
    if header is None:
        return _unsupported("concept_explanation", "Không xác định được trường cần giải thích.", "no_evidence")
    target_spec = (state.get("mapping") or {}).get(header)
    target = target_spec[0] if isinstance(target_spec, list) and target_spec else target_spec or header
    definition = field_definition(str(state.get("target_template_id") or ""), str(target))
    return _supported(
        "concept_explanation",
        f"{definition['title']}: {definition['meaning_vi']}",
        [_column_evidence(state, header, target_field=str(target))],
        answer_type="deterministic_explanation",
        rule_sources=[definition["source"]["source_url"]]
        if definition["source"].get("source_url")
        else [],
    )


def _answer_unsupported_judgment(question: str, state: dict[str, Any]) -> StudentAnswer:
    return _unsupported(
        "unsupported_legal_or_business_judgment",
        "File hiện tại không đủ căn cứ deterministic để kết luận pháp lý, thuế hoặc lựa chọn tài khoản chắc chắn.",
        "unsupported_legal_or_business_judgment",
        needs_professional_review=True,
    )


def _supported(
    intent: str,
    answer: str,
    evidence: list[StudentAnswerEvidence],
    *,
    evidence_count: int | None = None,
    answer_type: str = "deterministic_file_query",
    rule_sources: list[str] | None = None,
) -> StudentAnswer:
    bounded = evidence[:MAX_ANSWER_EVIDENCE]
    if not bounded:
        return _unsupported(
            intent,
            "Không có evidence hợp lệ để hỗ trợ câu trả lời từ file.",
            "no_evidence",
        )
    return StudentAnswer(
        answer=answer,
        intent=intent,
        answer_type=answer_type,
        confidence="verified",
        evidence=bounded,
        evidence_count=evidence_count if evidence_count is not None else len(evidence),
        rule_sources=rule_sources or [],
        needs_professional_review=False,
        unsupported_reason=None,
        outcome="supported",
    )


def _unsupported(
    intent: str,
    answer: str,
    reason: str,
    *,
    outcome: str = "unsupported",
    needs_professional_review: bool = False,
) -> StudentAnswer:
    return StudentAnswer(
        answer=answer,
        intent=intent,
        answer_type="unsupported",
        confidence="not_available",
        evidence=[],
        evidence_count=0,
        rule_sources=[],
        needs_professional_review=needs_professional_review,
        unsupported_reason=reason,
        outcome=outcome,
    )


def _table(state: dict[str, Any]) -> InputTable:
    table = state.get("table")
    if not isinstance(table, InputTable):
        raise ValueError("Student question state table không hợp lệ")
    return table


def _select_header(
    question: str,
    state: dict[str, Any],
    *,
    numeric_only: bool = False,
) -> str | None:
    table = _table(state)
    normalized_headers = {header: _normalize(header) for header in table.headers}
    direct = sorted(
        (
            header
            for header, normalized in normalized_headers.items()
            if normalized and normalized in question
        ),
        key=lambda header: len(normalized_headers[header]),
        reverse=True,
    )
    if direct:
        return direct[0]

    mapping = state.get("mapping") or {}
    for source, target_spec in mapping.items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        if any(_normalize(target) in question for target in targets if _normalize(target)):
            return source if source in table.headers else None

    aliases = (
        (("tong thanh toan", "tong tien thanh toan"), ("tong thanh toan", "tong tien")),
        (("tien thue", "thue gtgt", "vat"), ("tien thue",)),
        (("thue suat",), ("thue suat", "percent thue")),
        (("thanh tien",), ("thanh tien",)),
        (("don gia",), ("don gia", "dgvnd")),
        (("so luong",), ("so luong", "luong")),
        (("ten khach hang", "khach hang"), ("ten khach hang",)),
        (("ten nha cung cap", "nha cung cap"), ("ten nha cung cap", "ten ncc")),
        (("ma hang",), ("ma hang", "mathang")),
        (("ma hoa don", "so hoa don", "hoa don", "chung tu"), _DOCUMENT_TERMS),
        (("ngay hoa don",), ("ngay hoa don",)),
    )
    for question_terms, header_terms in aliases:
        if not any(term in question for term in question_terms):
            continue
        for header, normalized in normalized_headers.items():
            if any(term in normalized for term in header_terms):
                return header

    if numeric_only:
        return None
    return None


def _document_header(state: dict[str, Any]) -> str | None:
    table = _table(state)
    for header in table.headers:
        normalized = _normalize(header)
        if any(term == normalized or term in normalized for term in _DOCUMENT_TERMS):
            return header
    return None


def _cell_evidence(
    state: dict[str, Any],
    data_row_number: int,
    field: str,
    *,
    target_field: str | None = None,
) -> StudentAnswerEvidence:
    table = _table(state)
    worksheet_row = table.header_row_index + 1 + data_row_number
    actual = _json_value(table.rows[data_row_number - 1].get(field))
    return StudentAnswerEvidence(
        id=_evidence_id(
            state,
            "source_cell",
            table.sheet_name or "",
            worksheet_row,
            field,
            target_field,
            None,
        ),
        kind="source_cell",
        sheet=table.sheet_name or "",
        row=worksheet_row,
        field=field,
        target_field=target_field,
        actual=actual,
    )


def _column_evidence(
    state: dict[str, Any],
    field: str,
    *,
    target_field: str | None = None,
) -> StudentAnswerEvidence:
    table = _table(state)
    return StudentAnswerEvidence(
        id=_evidence_id(
            state,
            "source_column",
            table.sheet_name or "",
            None,
            field,
            target_field,
            None,
        ),
        kind="source_column",
        sheet=table.sheet_name or "",
        field=field,
        target_field=target_field,
    )


def _issue_evidence(
    state: dict[str, Any], issue: dict[str, Any]
) -> StudentAnswerEvidence | None:
    data_row_number = int(issue.get("row") or 0)
    table = _table(state)
    if not 1 <= data_row_number <= len(table.rows):
        return None
    source_field = _source_field_for_issue(state, issue)
    if source_field is None:
        return None
    worksheet_row = table.header_row_index + 1 + data_row_number
    target_field = str(issue.get("field") or "")
    issue_code = str(issue.get("code") or "")
    return StudentAnswerEvidence(
        id=_evidence_id(
            state,
            "issue",
            table.sheet_name or "",
            worksheet_row,
            source_field,
            target_field,
            issue_code,
        ),
        kind="issue",
        sheet=table.sheet_name or "",
        row=worksheet_row,
        field=source_field,
        target_field=target_field,
        actual=_json_value(issue.get("actual")),
        expected=_json_value(issue.get("expected")),
        issue_code=issue_code,
    )


def _source_field_for_issue(state: dict[str, Any], issue: dict[str, Any]) -> str | None:
    table = _table(state)
    target = str(issue.get("field") or "")
    if target in table.headers:
        return target
    for source, target_spec in (state.get("mapping") or {}).items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        if target in [str(item) for item in targets] and source in table.headers:
            return source
    code = str(issue.get("code") or "")
    if code == "duplicate_document_key":
        return _document_header(state)
    if code == "vat_amount_mismatch":
        return _select_header("tien thue gtgt", state)
    return table.headers[0] if table.headers else None


def _issues_by_code(state: dict[str, Any], code: str) -> list[dict[str, Any]]:
    return [
        issue
        for issue in (state.get("readiness") or {}).get("issues") or []
        if issue.get("code") == code
    ]


def _issue_sources(issues: list[dict[str, Any]]) -> list[str]:
    return sorted({str(issue["source_url"]) for issue in issues if issue.get("source_url")})


def _requested_row(question: str) -> int | None:
    match = re.search(r"\bdong\s+(\d+)\b", question)
    return int(match.group(1)) if match else None


def _worksheet_data_row(state: dict[str, Any], worksheet_row: int) -> int | None:
    table = _table(state)
    header_worksheet_row = table.header_row_index + 1
    first_data_row = header_worksheet_row + 1
    last_data_row = header_worksheet_row + len(table.rows)
    if not first_data_row <= worksheet_row <= last_data_row:
        return None
    return worksheet_row - header_worksheet_row


def _evidence_id(
    state: dict[str, Any],
    kind: str,
    sheet: str | None,
    row: int | None,
    field: str | None,
    target_field: str | None,
    issue_code: str | None,
) -> str:
    identity = "|".join(
        (
            str(state.get("state_hash") or ""),
            kind,
            str(sheet or ""),
            str(row or ""),
            str(field or ""),
            str(target_field or ""),
            str(issue_code or ""),
        )
    )
    return "question-evidence-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]


def _normalize(value: Any) -> str:
    text = str(value or "").replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_text = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.casefold()).strip()


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date, Decimal)):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _format_decimal(value: Decimal) -> str:
    normalized = format(value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"
