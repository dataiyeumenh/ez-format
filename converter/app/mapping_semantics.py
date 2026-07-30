from __future__ import annotations

from typing import Any

from app.misa_field_semantics import (
    FieldKind,
    is_strong_domain_mismatch,
    source_field_kind,
    template_field_registry,
)
from app.models import MisaReadinessIssue
from app.normalization import is_blank, normalize_header


MISA_IMPORT_SOURCE_URL = "https://helpact.misa.vn/kb/html_10050000/"


def validate_mapping_semantics(
    *,
    target_template_id: str,
    template_headers: list[str],
    source_headers: list[str],
    mapping: dict[str, object],
    defaults: dict[str, object],
    sample_rows: list[dict[str, object]],
    formulas: dict[str, object] | None = None,
    coa_codes: set[str] | None = None,
) -> list[MisaReadinessIssue]:
    """Validate mapping domains without mutating user, profile, or AI values."""
    formulas = formulas or {}
    issues: list[MisaReadinessIssue] = []
    source_set = set(source_headers)
    target_set = set(template_headers)
    target_registry = template_field_registry(target_template_id, template_headers)
    targets_seen: set[str] = set()

    for source_header, target_spec in mapping.items():
        if source_header not in source_set:
            issues.append(
                _issue(
                    "blocker",
                    "mapping",
                    "source_column_missing",
                    f"Cột nguồn '{source_header}' không tồn tại trong file đã tải.",
                    field=source_header,
                    expected="Cột nguồn tồn tại",
                    actual=source_header,
                )
            )
            continue
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        source_kind = source_field_kind(source_header)
        for raw_target in targets:
            target = str(raw_target or "").strip()
            if not target:
                continue
            targets_seen.add(target)
            if target not in target_set:
                issues.append(
                    _issue(
                        "blocker",
                        "mapping",
                        "target_column_unknown",
                        f"Cột MISA '{target}' không thuộc template đã chọn.",
                        field=target,
                        expected="Cột thuộc template thật",
                        actual=target,
                    )
                )
                continue
            target_kind = target_registry[target].kind
            if is_strong_domain_mismatch(source_kind, target_kind):
                issues.append(
                    _issue(
                        "blocker",
                        "mapping",
                        "mapping_domain_mismatch",
                        f"Cột nguồn '{source_header}' không phù hợp với cột MISA '{target}'.",
                        field=target,
                        expected=target_kind.value,
                        actual=source_kind.value,
                    )
                )

    for target in template_headers:
        if "(*)" not in target or target in targets_seen:
            continue
        if not is_blank(defaults.get(target)) and target in defaults:
            continue
        if not is_blank(formulas.get(target)) and target in formulas:
            continue
        issues.append(
            _issue(
                "blocker",
                "template",
                "required_mapping_missing",
                f"Cột bắt buộc '{target}' chưa có mapping, giá trị mặc định hoặc công thức.",
                field=target,
                expected="Có mapping/default/formula",
                actual="",
            )
        )

    _validate_accounts(
        issues,
        template_headers=template_headers,
        mapping=mapping,
        defaults=defaults,
        sample_rows=sample_rows,
        coa_codes=coa_codes,
        target_registry=target_registry,
    )
    return issues


def _validate_accounts(
    issues: list[MisaReadinessIssue],
    *,
    template_headers: list[str],
    mapping: dict[str, object],
    defaults: dict[str, object],
    sample_rows: list[dict[str, object]],
    coa_codes: set[str] | None,
    target_registry: dict[str, Any],
) -> None:
    account_targets = {
        target
        for target in template_headers
        if target_registry[target].kind == FieldKind.ACCOUNT
    }
    if not account_targets:
        return
    normalized_coa = {str(code).strip() for code in coa_codes or set()}
    for target in account_targets:
        source_headers = [
            source
            for source, target_spec in mapping.items()
            if target in (target_spec if isinstance(target_spec, list) else [target_spec])
        ]
        values = []
        if source_headers:
            values = [row.get(source_headers[0]) for row in sample_rows]
        elif target in defaults:
            values = [defaults.get(target)]
        for value in values:
            if is_blank(value):
                continue
            account = str(value).strip()
            if coa_codes is None:
                issues.append(
                    _issue(
                        "warning",
                        "master_data",
                        "account_master_data_unavailable",
                        f"Chưa thể xác minh tài khoản '{account}' vì chưa có danh mục tài khoản doanh nghiệp.",
                        field=target,
                        actual=account,
                        expected="Tài khoản tồn tại trong danh mục tài khoản MISA",
                    )
                )
            elif account not in normalized_coa:
                issues.append(
                    _issue(
                        "blocker",
                        "master_data",
                        "account_code_not_in_coa",
                        f"Tài khoản '{account}' không có trong danh mục tài khoản đã tải.",
                        field=target,
                        actual=account,
                        expected=sorted(normalized_coa),
                    )
                )


def _issue(
    severity: str,
    category: str,
    code: str,
    message: str,
    **kwargs: Any,
) -> MisaReadinessIssue:
    return MisaReadinessIssue(
        severity=severity,
        category=category,
        code=code,
        message=message,
        fix_hint="Kiểm tra lại cột nguồn và cột MISA trước khi xác nhận mapping.",
        source_url=MISA_IMPORT_SOURCE_URL,
        blocking_scope="export" if severity == "blocker" else "none",
        deterministic=True,
        correction_eligibility="review_required",
        **kwargs,
    )
