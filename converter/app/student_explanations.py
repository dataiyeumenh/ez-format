from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from typing import Any

from app.excel_io import InputTable
from app.misa_mapping import transform_value
from app.student_field_dictionary import field_definition
from app.student_models import StudentEvidence, StudentExplanation, StudentFileSummary


RULE_SOURCE_PREFIX = "urn:ezformat:student-rule"
MAX_ROW_SPECIFIC_EXPLANATION_ROWS = 25


def stable_explanation_id(
    *,
    session_id: str,
    upload_id: str,
    kind: str,
    target_field: str | None,
    rule_id: str,
) -> str:
    identity = "|".join(
        [session_id, upload_id, kind, target_field or "", rule_id]
    )
    return "exp_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def explanation_state_hash(
    *,
    session_id: str,
    upload_id: str,
    target_template_id: str,
    source_signature_hash: str,
    mapping_source: str,
    mapping_identity: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, Any],
) -> str:
    payload = {
        "session_id": session_id,
        "upload_id": upload_id,
        "target_template_id": target_template_id,
        "source_signature_hash": source_signature_hash,
        "mapping_source": mapping_source,
        "mapping_identity": mapping_identity,
        "mapping": mapping,
        "defaults": defaults,
        "formulas": formulas,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_student_explanations(
    *,
    session_id: str,
    upload_id: str,
    target_template_id: str,
    table: InputTable,
    target_headers: list[str],
    mapping_source: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, str],
    readiness: dict[str, Any],
    master_data: dict[str, Any],
    state_hash: str,
) -> list[StudentExplanation]:
    target_to_sources = _target_to_sources(mapping)
    explanations: list[StudentExplanation] = []

    for target_field in target_headers:
        definition = field_definition(target_template_id, target_field)
        sources = target_to_sources.get(target_field, [])
        active_modes = [
            mode
            for mode, active in (
                ("mapping", bool(sources)),
                ("default", _has_value(defaults.get(target_field))),
                ("formula", _has_value(formulas.get(target_field))),
            )
            if active
        ]
        if "formula" in active_modes:
            reason = f"Công thức hiện tại tạo giá trị cho trường {target_field}."
        elif "default" in active_modes:
            reason = f"Giá trị mặc định hiện tại được dùng cho trường {target_field}."
        elif "mapping" in active_modes:
            reason = (
                f"Trường {target_field} nhận dữ liệu từ cột nguồn "
                + ", ".join(sources)
                + "."
            )
        else:
            reason = f"Trường {target_field} chưa có mapping, mặc định hoặc công thức."

        severity = "none"
        if definition["required"] and not active_modes:
            severity = "blocker"
        elif len(active_modes) > 1:
            severity = "warning"

        evidence = [_template_evidence(definition)]
        for source_column in sources:
            evidence.append(_source_column_evidence(table, source_column))
        if "default" in active_modes:
            evidence.append(
                StudentEvidence(
                    kind="rule",
                    rule_id="mapping_default_value_v1",
                    source_ref=(
                        f"{RULE_SOURCE_PREFIX}:mapping-default:v1:"
                        f"{target_template_id}:{target_field}"
                    ),
                    raw_value=defaults.get(target_field),
                )
            )
        if "formula" in active_modes:
            evidence.append(
                StudentEvidence(
                    kind="rule",
                    rule_id="mapping_formula_v1",
                    source_ref=(
                        f"{RULE_SOURCE_PREFIX}:mapping-formula:v1:"
                        f"{target_template_id}:{target_field}"
                    ),
                    raw_value=formulas.get(target_field),
                )
            )
        explanations.append(
            _explanation(
                session_id=session_id,
                upload_id=upload_id,
                kind="field",
                severity=severity,
                target_field=target_field,
                rule_id=f"field:{target_field}",
                title=definition["title"],
                meaning_vi=definition["meaning_vi"],
                reason_vi=reason,
                impact_vi=(
                    "Trường bắt buộc chưa có nguồn dữ liệu nên readiness có thể bị chặn."
                    if severity == "blocker"
                    else None
                ),
                fix_hint_vi=definition["fix_hint_vi"],
                evidence=evidence,
                claim_sources=(
                    sources
                    if active_modes == ["mapping"]
                    else []
                ),
                state_hash=state_hash,
            )
        )

    for source_column, target_spec in mapping.items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        for target_field in targets:
            if target_field not in target_headers:
                continue
            definition = field_definition(target_template_id, target_field)
            rule_id = f"mapping:{mapping_source}:{source_column}"
            explanations.append(
                _explanation(
                    session_id=session_id,
                    upload_id=upload_id,
                    kind="mapping",
                    severity="none",
                    target_field=target_field,
                    rule_id=rule_id,
                    title=f"{source_column} -> {target_field}",
                    meaning_vi=definition["meaning_vi"],
                    reason_vi=(
                        f"Pipeline mapping hiện tại ({mapping_source}) gán cột "
                        f"{source_column} vào trường {target_field}."
                    ),
                    impact_vi="Giá trị của cột nguồn này sẽ được dùng để tạo dữ liệu đích.",
                    fix_hint_vi=(
                        "Mở cột nguồn và so sánh vài dòng với ý nghĩa của trường đích trước khi dùng."
                    ),
                    evidence=[
                        _source_column_evidence(table, source_column),
                        StudentEvidence(
                            kind="rule",
                            rule_id=f"mapping_source_{mapping_source}",
                            source_ref=f"{RULE_SOURCE_PREFIX}:mapping-source:{mapping_source}:v1",
                        ),
                    ],
                    claim_sources=[source_column],
                    state_hash=state_hash,
                )
            )

    explanations.extend(
        _normalization_explanations(
            session_id=session_id,
            upload_id=upload_id,
            target_template_id=target_template_id,
            table=table,
            mapping=mapping,
            state_hash=state_hash,
        )
    )
    explanations.extend(
        _formula_explanations(
            session_id=session_id,
            upload_id=upload_id,
            target_template_id=target_template_id,
            table=table,
            formulas=formulas,
            target_to_sources=target_to_sources,
            state_hash=state_hash,
        )
    )
    explanations.extend(
        _issue_explanations(
            session_id=session_id,
            upload_id=upload_id,
            target_template_id=target_template_id,
            table=table,
            readiness=readiness,
            target_to_sources=target_to_sources,
            state_hash=state_hash,
        )
    )

    master_status = str(master_data.get("status") or "not_configured")
    if master_status != "connected":
        explanations.append(
            _explanation(
                session_id=session_id,
                upload_id=upload_id,
                kind="master_data",
                severity="warning" if master_status == "unavailable" else "info",
                target_field=None,
                rule_id=f"master_data:{master_status}",
                title="Trạng thái đối chiếu danh mục",
                meaning_vi="Cho biết dữ liệu mã đã được đối chiếu với hồ sơ doanh nghiệp hay chưa.",
                reason_vi=(
                    str(master_data.get("message") or "Chưa cấu hình hồ sơ doanh nghiệp để đối chiếu mã.")
                ),
                impact_vi="Các mã khách hàng, nhà cung cấp, hàng hóa hoặc kho có thể vẫn cần rà soát.",
                fix_hint_vi="Chọn hồ sơ doanh nghiệp nếu cần xác minh danh mục, hoặc kiểm tra mã trực tiếp.",
                evidence=[
                    StudentEvidence(
                        kind="rule",
                        rule_id="master_data_context_status_v1",
                        source_ref=f"{RULE_SOURCE_PREFIX}:master-data-context:v1",
                        raw_value=master_status,
                    )
                ],
                state_hash=state_hash,
            )
        )

    return explanations


def build_student_summary(
    *,
    session_id: str,
    upload_id: str,
    file_name: str,
    target_template_id: str,
    table: InputTable,
    target_headers: list[str],
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, str],
    preview: dict[str, Any],
    readiness: dict[str, Any],
    explanation_count: int,
    state_hash: str,
) -> StudentFileSummary:
    target_to_sources = _target_to_sources(mapping)
    mapping_counts = {
        "mapped": 0,
        "default": 0,
        "formula": 0,
        "unresolved": 0,
        "mixed": 0,
    }
    for target in target_headers:
        active = sum(
            [
                bool(target_to_sources.get(target)),
                _has_value(defaults.get(target)),
                _has_value(formulas.get(target)),
            ]
        )
        if active > 1:
            mapping_counts["mixed"] += 1
        elif target_to_sources.get(target):
            mapping_counts["mapped"] += 1
        elif _has_value(defaults.get(target)):
            mapping_counts["default"] += 1
        elif _has_value(formulas.get(target)):
            mapping_counts["formula"] += 1
        else:
            mapping_counts["unresolved"] += 1

    recognized_source_columns = sum(1 for header in table.headers if header in mapping)
    issue_summary = readiness.get("summary") or {}
    reconciliation = readiness.get("reconciliation") or {}
    totals = {
        key: reconciliation.get(key)
        for key in ("sum_amount", "sum_vat", "sum_total")
        if reconciliation.get(key) not in (None, "")
    }
    rows = preview.get("rows") or []
    return StudentFileSummary(
        session_id=session_id,
        upload_id=upload_id,
        file_name=file_name,
        target_template_id=target_template_id,
        sheet_name=table.sheet_name or "",
        header_row=table.header_row_index + 1,
        data_row_count=len(table.rows),
        document_count=_document_count(rows),
        recognized_columns=recognized_source_columns,
        unresolved_columns=max(0, len(table.headers) - recognized_source_columns),
        mapping_counts=mapping_counts,
        issue_counts={
            "blocker": int(issue_summary.get("blocker") or 0),
            "warning": int(issue_summary.get("warning") or 0),
            "info": int(issue_summary.get("info") or 0),
        },
        master_data_status=str(
            (preview.get("master_data") or {}).get("status") or "not_configured"
        ),
        reconcilable_totals=totals,
        explanation_count=explanation_count,
        state_hash=state_hash,
    )


def _normalization_explanations(
    *,
    session_id: str,
    upload_id: str,
    target_template_id: str,
    table: InputTable,
    mapping: dict[str, Any],
    state_hash: str,
) -> list[StudentExplanation]:
    items: list[StudentExplanation] = []
    emitted_cells: set[tuple[str, int]] = set()
    for row_index, source_row in enumerate(table.rows):
        if row_index >= MAX_ROW_SPECIFIC_EXPLANATION_ROWS:
            break
        for source_column, target_spec in mapping.items():
            if source_column not in source_row:
                continue
            raw_value = source_row.get(source_column)
            if not _has_value(raw_value):
                continue
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            for target_field in targets:
                cell_key = (str(target_field), row_index)
                if cell_key in emitted_cells:
                    continue
                normalized_value = transform_value(raw_value, target_field)
                if not _normalization_changed(raw_value, normalized_value):
                    continue
                definition = field_definition(target_template_id, target_field)
                rule_id = f"normalization:{target_field}:{row_index + 1}"
                items.append(
                    _explanation(
                        session_id=session_id,
                        upload_id=upload_id,
                        kind="normalization",
                        severity="info",
                        target_field=target_field,
                        rule_id=rule_id,
                        title=f"Chuẩn hóa {target_field}",
                        meaning_vi=definition["meaning_vi"],
                        reason_vi=(
                            f"Giá trị từ cột {source_column} được chuẩn hóa theo kiểu dữ liệu "
                            f"của trường {target_field}."
                        ),
                        impact_vi="Dữ liệu đích có thể khác cách hiển thị ban đầu nhưng vẫn giữ giá trị đã đọc.",
                        fix_hint_vi="Mở ô nguồn được dẫn chiếu và xác nhận giá trị chuẩn hóa là đúng.",
                        normalized_value=normalized_value,
                        evidence=[
                            _source_cell_evidence(
                                table, row_index, source_column, raw_value
                            ),
                            StudentEvidence(
                                kind="rule",
                                rule_id="misa_transform_value_v1",
                                source_ref=f"{RULE_SOURCE_PREFIX}:misa-transform-value:v1",
                            ),
                        ],
                        claim_sources=[source_column],
                        preview_row=row_index + 1,
                        state_hash=state_hash,
                    )
                )
                emitted_cells.add(cell_key)
    return items


def _formula_explanations(
    *,
    session_id: str,
    upload_id: str,
    target_template_id: str,
    table: InputTable,
    formulas: dict[str, str],
    target_to_sources: dict[str, list[str]],
    state_hash: str,
) -> list[StudentExplanation]:
    items: list[StudentExplanation] = []
    for target_field, expression in formulas.items():
        definition = field_definition(target_template_id, target_field)
        evidence: list[StudentEvidence] = [
            StudentEvidence(
                kind="rule",
                rule_id="mapping_formula_v1",
                source_ref=(
                    f"{RULE_SOURCE_PREFIX}:mapping-formula:v1:"
                    f"{target_template_id}:{target_field}"
                ),
                raw_value=expression,
            )
        ]
        referenced_targets = re.findall(r"\$\{(.+?)\}", str(expression))
        for referenced_target in referenced_targets:
            for source_column in target_to_sources.get(referenced_target, []):
                candidate = _source_column_evidence(table, source_column)
                if candidate.source_ref not in {item.source_ref for item in evidence}:
                    evidence.append(candidate)
        items.append(
            _explanation(
                session_id=session_id,
                upload_id=upload_id,
                kind="calculation",
                severity="info",
                target_field=target_field,
                rule_id=f"formula:{target_field}",
                title=f"Công thức {target_field}",
                meaning_vi=definition["meaning_vi"],
                reason_vi=f"Trường {target_field} được tính bằng công thức {expression}.",
                impact_vi="Kết quả phụ thuộc vào các trường được tham chiếu trong công thức.",
                fix_hint_vi="Kiểm tra mapping của các trường tham chiếu và đối chiếu vài dòng kết quả.",
                evidence=evidence,
                state_hash=state_hash,
            )
        )
    return items


def _issue_explanations(
    *,
    session_id: str,
    upload_id: str,
    target_template_id: str,
    table: InputTable,
    readiness: dict[str, Any],
    target_to_sources: dict[str, list[str]],
    state_hash: str,
) -> list[StudentExplanation]:
    items: list[StudentExplanation] = []
    for issue in readiness.get("issues") or []:
        field = str(issue.get("field") or "").strip() or None
        definition = field_definition(target_template_id, field) if field else None
        code = str(issue.get("code") or "readiness_issue")
        row = _positive_int(issue.get("row"))
        issue_fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "code": code,
                    "row": row,
                    "field": field,
                    "message": issue.get("message"),
                    "expected": issue.get("expected"),
                    "actual": issue.get("actual"),
                },
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            ).encode("utf-8")
        ).hexdigest()[:12]
        rule_id = f"readiness:{code}:{row or 'all'}:{issue_fingerprint}"
        evidence: list[StudentEvidence] = [
            StudentEvidence(
                kind="rule",
                rule_id=code,
                source_ref=f"{RULE_SOURCE_PREFIX}:readiness:{code}:v1",
                source_url=issue.get("source_url"),
            )
        ]
        for source in issue.get("evidence") or []:
            if not isinstance(source, dict):
                continue
            try:
                evidence.insert(0, StudentEvidence.model_validate(source))
            except ValueError:
                continue
        if field and row and row <= len(table.rows):
            for source_column in target_to_sources.get(field, [])[:1]:
                evidence.insert(
                    0,
                    _source_cell_evidence(
                        table,
                        row - 1,
                        source_column,
                        table.rows[row - 1].get(source_column),
                    ),
                )
        severity = str(issue.get("severity") or "warning")
        if severity not in {"blocker", "warning", "info"}:
            severity = "warning"
        items.append(
            _explanation(
                session_id=session_id,
                upload_id=upload_id,
                kind="issue",
                severity=severity,
                target_field=field,
                rule_id=rule_id,
                title=(definition["title"] if definition else "Vấn đề cần rà soát"),
                meaning_vi=(
                    definition["meaning_vi"]
                    if definition
                    else "Vấn đề được tạo bởi readiness rules engine hiện có."
                ),
                reason_vi=str(issue.get("message") or code),
                impact_vi=(
                    "Vấn đề chắc chắn cần sửa trước khi export."
                    if severity == "blocker"
                    else "Vấn đề cần được rà soát trước khi tiếp tục."
                ),
                fix_hint_vi=str(
                    issue.get("fix_hint")
                    or (definition or {}).get("fix_hint_vi")
                    or "Đối chiếu bằng chứng và chỉnh dữ liệu hoặc mapping liên quan."
                ),
                normalized_value=issue.get("actual"),
                evidence=evidence,
                preview_row=row,
                issue_code=code,
                issue_row=row,
                state_hash=state_hash,
            )
        )
    return items


def _explanation(
    *,
    session_id: str,
    upload_id: str,
    kind: str,
    severity: str,
    target_field: str | None,
    rule_id: str,
    title: str,
    meaning_vi: str,
    reason_vi: str,
    fix_hint_vi: str,
    evidence: list[StudentEvidence],
    state_hash: str,
    claim_sources: list[str] | None = None,
    preview_row: int | None = None,
    issue_code: str | None = None,
    issue_row: int | None = None,
    impact_vi: str | None = None,
    normalized_value: Any = None,
) -> StudentExplanation:
    return StudentExplanation(
        id=stable_explanation_id(
            session_id=session_id,
            upload_id=upload_id,
            kind=kind,
            target_field=target_field,
            rule_id=rule_id,
        ),
        kind=kind,
        severity=severity,
        deterministic=True,
        target_field=target_field,
        title=title,
        meaning_vi=meaning_vi,
        reason_vi=reason_vi,
        impact_vi=impact_vi,
        fix_hint_vi=fix_hint_vi,
        normalized_value=normalized_value,
        evidence=evidence,
        claim_sources=list(claim_sources or []),
        preview_row=preview_row,
        issue_code=issue_code,
        issue_row=issue_row,
        state_hash=state_hash,
        stale=False,
    )


def _template_evidence(definition: dict[str, Any]) -> StudentEvidence:
    source = definition["source"]
    return StudentEvidence(
        kind="template",
        rule_id=source["rule_id"],
        source_ref=source["source_ref"],
        source_url=source.get("source_url"),
        checked_at=source.get("checked_at"),
        effective_from=source.get("effective_from"),
        effective_to=source.get("effective_to"),
    )


def _source_column_evidence(table: InputTable, source_column: str) -> StudentEvidence:
    return StudentEvidence(
        kind="source_column",
        sheet=table.sheet_name or "",
        column=source_column,
        source_ref=f"sheet:{table.sheet_name or ''}:column:{source_column}",
    )


def _source_cell_evidence(
    table: InputTable,
    row_index: int,
    source_column: str,
    raw_value: Any,
) -> StudentEvidence:
    source_row_number = table.header_row_index + 2 + row_index
    return StudentEvidence(
        kind="source_cell",
        sheet=table.sheet_name or "",
        row=source_row_number,
        column=source_column,
        raw_value=raw_value,
        source_ref=(
            f"sheet:{table.sheet_name or ''}:row:{source_row_number}:column:{source_column}"
        ),
    )


def _target_to_sources(mapping: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for source_column, target_spec in mapping.items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        for target in targets:
            if not target:
                continue
            result.setdefault(str(target), []).append(str(source_column))
    return result


def _document_count(rows: list[dict[str, Any]]) -> int | None:
    for field in ("Số chứng từ (*)", "Số phiếu nhập (*)", "Số hóa đơn"):
        values = {
            str(row.get(field)).strip()
            for row in rows
            if _has_value(row.get(field))
        }
        if values:
            return len(values)
    return None


def _normalization_changed(raw_value: Any, normalized_value: Any) -> bool:
    if isinstance(normalized_value, (date, datetime)):
        return True
    return type(raw_value) is not type(normalized_value) or raw_value != normalized_value


def _has_value(value: Any) -> bool:
    return value is not None and str(value).strip() != ""


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
