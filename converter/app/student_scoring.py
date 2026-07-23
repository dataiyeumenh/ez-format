from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel, Field


RUBRIC_WEIGHTS = {
    "mapping": Decimal("30"),
    "required_completeness": Decimal("20"),
    "date_number": Decimal("15"),
    "vat_amount": Decimal("20"),
    "classification": Decimal("10"),
    "correction_after_hints": Decimal("5"),
}

_CATEGORY_LABELS = {
    "mapping": "mapping cột",
    "required_completeness": "trường bắt buộc",
    "date_number": "ngày và số",
    "vat_amount": "thuế và số tiền",
    "classification": "phân loại chứng từ",
    "correction_after_hints": "sửa bài sau gợi ý",
}

_CONCEPT_HINTS = {
    "mapping": "Đối chiếu ý nghĩa cột nguồn với trường đích, không chỉ so tên cột.",
    "required_completeness": "Trường bắt buộc phải có mapping, mặc định hoặc công thức có căn cứ.",
    "date_number": "Ngày và số phải được chuẩn hóa theo kiểu dữ liệu mà mẫu đích chấp nhận.",
    "vat_amount": "Số tiền và VAT phải khớp các thành phần tính toán độc lập.",
    "classification": "Phân loại dựa trên chiều mua/bán và bản chất hàng hóa/dịch vụ có bằng chứng.",
    "correction_after_hints": "Điểm này ghi nhận việc sửa đúng sau khi đã dùng gợi ý.",
}

_DECIMAL_TEXT = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")


class AttemptBreakdown(BaseModel):
    category: str
    label_vi: str
    max_score: Decimal
    earned: Decimal
    matched: int = Field(ge=0)
    total: int = Field(ge=0)


class AttemptIssue(BaseModel):
    id: str
    category: str
    label_vi: str
    target_refs: list[str] = Field(default_factory=list)
    expected_value: Any = None


class AttemptHint(BaseModel):
    issue_id: str
    level: int = Field(ge=0, le=4)
    text_vi: str


class AttemptEvaluation(BaseModel):
    kind: str
    rubric_version: str
    submitted_state_hash: str
    score: Decimal
    breakdown: list[AttemptBreakdown]
    issues: list[AttemptIssue]

    def public_payload(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "rubric_version": self.rubric_version,
            "submitted_state_hash": self.submitted_state_hash,
            "score": _json_decimal(self.score),
            "breakdown": [
                {
                    "category": item.category,
                    "label_vi": item.label_vi,
                    "max_score": _json_decimal(item.max_score),
                    "earned": _json_decimal(item.earned),
                    "matched": item.matched,
                    "total": item.total,
                }
                for item in self.breakdown
            ],
            "issues": [
                {
                    "id": item.id,
                    "category": item.category,
                    "label_vi": item.label_vi,
                }
                for item in self.issues
            ],
        }


def score_attempt(
    kind: str,
    submitted: dict[str, Any],
    expected: dict[str, Any],
    rubric_version: str = "student-v1",
) -> AttemptEvaluation:
    normalized_kind = str(kind or "").strip()
    if not normalized_kind:
        raise ValueError("Attempt kind is required")
    if rubric_version != "student-v1":
        raise ValueError(f"Unsupported student rubric version: {rubric_version}")

    breakdown: list[AttemptBreakdown] = []
    issues: list[AttemptIssue] = []
    score = Decimal("0")
    for category, weight in RUBRIC_WEIGHTS.items():
        if category not in expected:
            matched = total = 1
        else:
            matched, total, mismatches = _compare_values(
                submitted.get(category),
                expected[category],
            )
            if mismatches:
                issues.append(
                    AttemptIssue(
                        id=_issue_id(normalized_kind, category, mismatches),
                        category=category,
                        label_vi=_CATEGORY_LABELS[category],
                        target_refs=mismatches[:20],
                        expected_value=_canonical_value(expected[category]),
                    )
                )
        ratio = Decimal(matched) / Decimal(total or 1)
        earned = (weight * ratio).quantize(Decimal("0.01"))
        score += earned
        breakdown.append(
            AttemptBreakdown(
                category=category,
                label_vi=_CATEGORY_LABELS[category],
                max_score=weight,
                earned=earned,
                matched=matched,
                total=total,
            )
        )

    return AttemptEvaluation(
        kind=normalized_kind,
        rubric_version=rubric_version,
        submitted_state_hash=canonical_state_hash(submitted),
        score=score.quantize(Decimal("0.01")),
        breakdown=breakdown,
        issues=issues,
    )


def hint_for(evaluation: AttemptEvaluation, issue_id: str, level: int) -> AttemptHint:
    if not 0 <= int(level) <= 4:
        raise ValueError("Hint level must be between 0 and 4")
    issue = next((item for item in evaluation.issues if item.id == issue_id), None)
    if issue is None:
        raise KeyError(issue_id)

    normalized_level = int(level)
    if normalized_level == 0:
        text = f"Kết quả: phần {issue.label_vi} chưa đạt."
    elif normalized_level == 1:
        text = _CONCEPT_HINTS[issue.category]
    elif normalized_level == 2:
        text = f"Nhóm cần kiểm tra: {issue.label_vi}."
    elif normalized_level == 3:
        targets = ", ".join(issue.target_refs[:5]) or issue.label_vi
        text = f"Vị trí cần kiểm tra: {targets}."
    else:
        expected = json.dumps(
            issue.expected_value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        text = f"Kết quả mong đợi cho {issue.label_vi}: {expected}."
    return AttemptHint(issue_id=issue.id, level=normalized_level, text_vi=text)


def canonical_state_hash(value: Any) -> str:
    payload = json.dumps(
        _canonical_value(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _compare_values(
    submitted: Any,
    expected: Any,
    path: str = "",
) -> tuple[int, int, list[str]]:
    if isinstance(expected, dict):
        if not expected:
            return (1, 1, []) if _canonical_value(submitted) == {} else (0, 1, [path or "value"])
        matched = 0
        total = 0
        mismatches: list[str] = []
        submitted_dict = submitted if isinstance(submitted, dict) else {}
        for key in sorted(expected, key=str):
            child_path = f"{path}.{key}" if path else str(key)
            child_matched, child_total, child_mismatches = _compare_values(
                submitted_dict.get(key),
                expected[key],
                child_path,
            )
            matched += child_matched
            total += child_total
            mismatches.extend(child_mismatches)
        return matched, total, mismatches
    if isinstance(expected, list):
        canonical_expected = _canonical_value(expected)
        canonical_submitted = _canonical_value(submitted)
        return (
            (1, 1, [])
            if canonical_submitted == canonical_expected
            else (0, 1, [path or "value"])
        )
    is_match = _canonical_value(submitted) == _canonical_value(expected)
    return (1, 1, []) if is_match else (0, 1, [path or "value"])


def _canonical_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _canonical_value(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, Decimal):
        return _decimal_text(value)
    if isinstance(value, (int, float)):
        try:
            return _decimal_text(Decimal(str(value)))
        except InvalidOperation:
            return str(value)
    if isinstance(value, str):
        stripped = value.strip()
        if _DECIMAL_TEXT.fullmatch(stripped):
            try:
                return _decimal_text(Decimal(stripped))
            except InvalidOperation:
                pass
        return stripped
    return str(value)


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))
    return format(normalized, "f")


def _json_decimal(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral() else float(value)


def _issue_id(kind: str, category: str, mismatches: list[str]) -> str:
    payload = json.dumps(
        {"kind": kind, "category": category, "targets": sorted(mismatches)},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]
