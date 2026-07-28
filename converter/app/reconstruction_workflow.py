from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import httpx

from app.excel_io import read_input_table
from app.field_provenance import apply_master_data_to_drafts
from app.document_structure import (
    enforce_workbook_limits,
    inspect_workbook_structure,
    validate_excel_magic,
)
from app.master_data_client import (
    ConversionContextError,
    fetch_master_data_context,
    verify_reconstruction_context_token,
)
from app.misa_voucher_adapters import (
    drafts_to_template_rows,
    export_template_rows,
    validate_template_rows,
)
from app.reconstruction_profile_client import (
    ReconstructionProfileClientError,
    assert_reconstruction_profile_current,
    find_reconstruction_profile,
)
from app.reconstruction_store import (
    ReconstructionStoreConflictError,
    ReconstructionStoreError,
    get_reconstruction_store,
)
from app.voucher_models import (
    FieldProvenance,
    VoucherDraft,
    VoucherField,
    VoucherReconstructionReport,
)
from app.voucher_reconstruction import reconstruct_vouchers


class ReconstructionConflictError(ValueError):
    pass


class ReconstructionGateError(ValueError):
    def __init__(self, validation: dict[str, Any]) -> None:
        self.validation = validation
        super().__init__("Reconstruction gate failed")


def analyze_reconstruction(
    *,
    filename: str,
    content: bytes,
    context_token: str,
    mode: str = "auto",
    target_template_id: str | None = None,
    use_ai: bool = False,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    _require_enabled()
    claims = verify_reconstruction_context_token(context_token, required_scope="analyze")
    reconstruction_id = str(claims["run_id"])
    _notify_node(context_token, reconstruction_id, "analyzing", {})
    validate_excel_magic(filename, content)
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise ValueError("Chỉ hỗ trợ file .xls và .xlsx")
    temporary_upload = tempfile.TemporaryDirectory(
        prefix="ezformat-reconstruction-upload-"
    )
    input_path = Path(temporary_upload.name) / f"input{suffix}"
    input_path.write_bytes(content)
    table = read_input_table(input_path)
    enforce_workbook_limits(
        content_size=len(content),
        row_count=len(table.rows),
        column_count=len(table.headers),
    )
    structure = inspect_workbook_structure(input_path)
    temporary_upload.cleanup()
    if structure.get("has_external_links"):
        raise ValueError("Workbook có external links không được hỗ trợ")
    master_data_context, context_status, context_message = _master_data_context(
        claims,
        context_token,
    )
    workspace_tax_code = str(
        ((master_data_context or {}).get("workspace") or {}).get("taxCode") or ""
    )

    profile: dict[str, Any] | None = None
    profile_warning: str | None = None
    ai_suggestion: dict[str, Any] | None = None
    ai_warning: str | None = None
    ai_duration_ms = 0.0
    preliminary = reconstruct_vouchers(
        table,
        mode=mode,
        workspace_tax_code=workspace_tax_code,
        requested_template_id=target_template_id,
    )
    _enforce_draft_limit(preliminary)
    if claims.get("workspace_id"):
        try:
            profile = find_reconstruction_profile(
                context_token,
                source_signature_hash=preliminary.source_signature_hash,
            )
        except ReconstructionProfileClientError as exc:
            profile_warning = str(exc)
    resolved_mode = mode
    if profile and mode == "auto" and profile.get("directionScope") in {
        "purchase",
        "sales",
    }:
        resolved_mode = str(profile["directionScope"])
    report = (
        reconstruct_vouchers(
            table,
            mode=resolved_mode,
            workspace_tax_code=workspace_tax_code,
            requested_template_id=target_template_id,
            column_mapping=_profile_column_mapping(profile),
            fill_down_fields=(profile or {}).get("fillDownFields"),
            grouping_keys=(profile or {}).get("groupingKeys"),
            template_routing=(profile or {}).get("templateRouting"),
        )
        if profile
        else preliminary
    )
    _enforce_draft_limit(report)
    # Reconstruction analysis is deterministic. AI may explain a completed
    # result through an explicit endpoint, but cannot alter grouping/direction.
    _ = use_ai
    apply_master_data_to_drafts(report.drafts, master_data_context)
    payload = report.model_dump(mode="json")
    payload["reconstruction_id"] = reconstruction_id
    payload["profile"] = profile
    payload["profile_warning"] = profile_warning
    payload["ai"] = {
        "used": bool(ai_suggestion),
        "suggestion": ai_suggestion,
        "warning": ai_warning,
    }
    payload["structure"] = structure
    payload["metrics"] = {
        "analyze_duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        "ai_used": bool(ai_suggestion),
        "ai_duration_ms": ai_duration_ms,
        "profile_used": bool(profile),
        "review_rate": round(
            report.summary.needs_review / max(1, report.summary.draft_count),
            4,
        ),
        "blocker_rate": round(
            report.summary.blocked / max(1, report.summary.draft_count),
            4,
        ),
    }
    state = {
        "reconstruction_id": reconstruction_id,
        "context_claims": claims,
        "context_token_hash": hashlib.sha256(context_token.encode("utf-8")).hexdigest(),
        "mode": resolved_mode,
        "requested_template_id": target_template_id,
        "source_file_hash": hashlib.sha256(content).hexdigest(),
        "profile": profile,
        "structure": structure,
        "report": payload,
        "status": "review_required",
        "latest_revision": max((draft.revision for draft in report.drafts), default=0),
        "acknowledged_warnings": False,
        "master_data_context": master_data_context,
        "context_status": context_status,
        "context_message": context_message,
        "decisions": [],
        "metrics": payload["metrics"],
    }
    _save_state(reconstruction_id, state, initial=True)
    _notify_node(
        context_token,
        reconstruction_id,
        "analysis_completed",
        _node_summary(report),
        source_file_hash=state["source_file_hash"],
        source_signature_hash=report.source_signature_hash,
        latest_draft_revision=state["latest_revision"],
        metrics=state["metrics"],
        profile_id=(profile or {}).get("id"),
        profile_version=(profile or {}).get("version"),
    )
    return payload


def get_reconstruction(
    reconstruction_id: str,
    *,
    context_token: str,
    page: int = 1,
    limit: int = 100,
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    payload = deepcopy(state["report"])
    drafts = payload.get("drafts") or []
    resolved_page = max(1, int(page))
    resolved_limit = min(500, max(1, int(limit)))
    start = (resolved_page - 1) * resolved_limit
    payload["drafts"] = drafts[start : start + resolved_limit]
    payload["pagination"] = {
        "page": resolved_page,
        "limit": resolved_limit,
        "total": len(drafts),
        "total_pages": max(1, (len(drafts) + resolved_limit - 1) // resolved_limit),
    }
    return payload


def get_reconstruction_draft(
    reconstruction_id: str,
    draft_id: str,
    *,
    context_token: str,
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    report = VoucherReconstructionReport.model_validate(state["report"])
    draft = next((item for item in report.drafts if item.id == draft_id), None)
    if not draft:
        raise KeyError(f"Không tìm thấy draft {draft_id}")
    return draft.model_dump(mode="json")


def update_reconstruction_draft(
    reconstruction_id: str,
    draft_id: str,
    *,
    context_token: str,
    expected_revision: int,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    report = VoucherReconstructionReport.model_validate(state["report"])
    draft = next((item for item in report.drafts if item.id == draft_id), None)
    if not draft:
        raise KeyError(f"Không tìm thấy draft {draft_id}")
    if draft.revision != expected_revision:
        raise ReconstructionConflictError(
            "Draft đã thay đổi; vui lòng tải lại dữ liệu trước khi sửa"
        )
    decisions: list[dict[str, Any]] = []
    for operation in operations[:100]:
        decisions.append(_apply_operation(draft, operation))
    draft.revision += 1
    _refresh_draft(draft)
    _refresh_report(report)
    state["report"] = _report_payload(
        report,
        reconstruction_id,
        state.get("profile"),
        previous=state.get("report"),
    )
    state["latest_revision"] = max(item.revision for item in report.drafts)
    state["status"] = "review_required"
    state["decisions"] = [*(state.get("decisions") or []), *decisions][-1000:]
    _save_state(reconstruction_id, state)
    _notify_node(
        context_token,
        reconstruction_id,
        "review_updated",
        _node_summary(report),
        latest_draft_revision=state["latest_revision"],
        decisions=decisions,
    )
    return draft.model_dump(mode="json")


def split_reconstruction_draft(
    reconstruction_id: str,
    *,
    context_token: str,
    draft_id: str,
    expected_revision: int,
    source_rows: list[int],
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    report = VoucherReconstructionReport.model_validate(state["report"])
    draft = next((item for item in report.drafts if item.id == draft_id), None)
    if not draft:
        raise KeyError(f"Không tìm thấy draft {draft_id}")
    if draft.revision != expected_revision:
        raise ReconstructionConflictError("Draft đã thay đổi; vui lòng tải lại")
    selected = set(int(row) for row in source_rows)
    moving = [line for line in draft.lines if selected.intersection(line.source_rows)]
    staying = [line for line in draft.lines if line not in moving]
    if not moving or not staying:
        raise ValueError("Split cần chọn một phần, không phải toàn bộ dòng của chứng từ")
    original_id = draft.id
    draft.lines = staying
    draft.source_rows = sorted({row for line in staying for row in line.source_rows})
    draft.revision += 1
    draft.id = _derived_draft_id(original_id, draft.source_rows)
    _refresh_draft(draft)
    created = deepcopy(draft)
    created.lines = moving
    created.source_rows = sorted({row for line in moving for row in line.source_rows})
    created.id = _derived_draft_id(original_id, created.source_rows)
    created.revision = 1
    _refresh_draft(created)
    report.drafts.append(created)
    _refresh_report(report)
    decision = {
        "draftStableId": original_id,
        "draftRevision": expected_revision,
        "operationType": "split",
        "fieldPath": "",
        "beforeHash": _value_hash(sorted(draft.source_rows + created.source_rows)),
        "afterHash": _value_hash([draft.source_rows, created.source_rows]),
        "structuralRule": {},
        "sourceRows": sorted(selected),
    }
    state["report"] = _report_payload(
        report,
        reconstruction_id,
        state.get("profile"),
        previous=state.get("report"),
    )
    state["latest_revision"] = max(item.revision for item in report.drafts)
    state["status"] = "review_required"
    state["decisions"] = [*(state.get("decisions") or []), decision][-1000:]
    _save_state(reconstruction_id, state)
    _notify_node(
        context_token,
        reconstruction_id,
        "review_updated",
        _node_summary(report),
        latest_draft_revision=state["latest_revision"],
        decisions=[decision],
    )
    return state["report"]


def merge_reconstruction_drafts(
    reconstruction_id: str,
    *,
    context_token: str,
    draft_ids: list[str],
    expected_revisions: dict[str, int] | None = None,
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    report = VoucherReconstructionReport.model_validate(state["report"])
    selected = [draft for draft in report.drafts if draft.id in set(draft_ids)]
    if len(selected) != 2:
        raise ValueError("MVP chỉ hỗ trợ merge đúng hai chứng từ mỗi lần")
    expected = expected_revisions or {}
    if any(int(expected.get(draft.id) or 0) != draft.revision for draft in selected):
        raise ReconstructionConflictError(
            "Chứng từ đã thay đổi; vui lòng tải lại trước khi gộp"
        )
    if len({draft.direction for draft in selected}) != 1:
        raise ValueError("Không thể merge chứng từ mua và bán")
    merged = deepcopy(selected[0])
    _merge_headers(merged, selected[1])
    merged.lines = [*selected[0].lines, *selected[1].lines]
    merged.source_rows = sorted(set(selected[0].source_rows + selected[1].source_rows))
    merged.id = _derived_draft_id("merge:" + ":".join(sorted(draft_ids)), merged.source_rows)
    merged.revision = max(selected[0].revision, selected[1].revision) + 1
    _refresh_draft(merged)
    report.drafts = [draft for draft in report.drafts if draft.id not in set(draft_ids)]
    report.drafts.append(merged)
    _refresh_report(report)
    decision = {
        "draftStableId": merged.id,
        "draftRevision": merged.revision,
        "operationType": "merge",
        "fieldPath": "",
        "beforeHash": _value_hash(sorted(draft_ids)),
        "afterHash": _value_hash(merged.source_rows),
        "structuralRule": {},
        "sourceRows": merged.source_rows,
    }
    state["report"] = _report_payload(
        report,
        reconstruction_id,
        state.get("profile"),
        previous=state.get("report"),
    )
    state["latest_revision"] = max(item.revision for item in report.drafts)
    state["status"] = "review_required"
    state["decisions"] = [*(state.get("decisions") or []), decision][-1000:]
    _save_state(reconstruction_id, state)
    _notify_node(
        context_token,
        reconstruction_id,
        "review_updated",
        _node_summary(report),
        latest_draft_revision=state["latest_revision"],
        decisions=[decision],
    )
    return state["report"]


def validate_reconstruction(
    reconstruction_id: str,
    *,
    context_token: str,
) -> dict[str, Any]:
    state = _load_authorized(reconstruction_id, context_token, "review")
    _refresh_current_context(state, context_token)
    report = VoucherReconstructionReport.model_validate(state["report"])
    template_rows = drafts_to_template_rows(report.drafts)
    validation = validate_template_rows(
        template_rows,
        master_data_context=state.get("master_data_context"),
        context_status=str(state.get("context_status") or "not_configured"),
        context_message=state.get("context_message"),
    )
    reconstruction_blockers = sum(
        1
        for draft in report.drafts
        for issue in draft.issues
        if issue.severity == "blocker"
    )
    reconstruction_warnings = sum(
        1
        for draft in report.drafts
        for issue in draft.issues
        if issue.severity == "warning"
    )
    validation["summary"]["blocker"] += reconstruction_blockers
    validation["summary"]["warning"] += reconstruction_warnings
    validation["status"] = (
        "blocked"
        if validation["summary"]["blocker"]
        else "needs_review"
        if validation["summary"]["warning"]
        else "ready"
    )
    validation["reconstruction"] = {
        "summary": report.summary.model_dump(mode="json"),
        "row_conservation": report.row_conservation.model_dump(mode="json"),
    }
    state["validation"] = validation
    _save_state(reconstruction_id, state)
    return validation


def approve_reconstruction(
    reconstruction_id: str,
    *,
    context_token: str,
    acknowledge_warnings: bool,
) -> dict[str, Any]:
    verify_reconstruction_context_token(context_token, required_scope="approve")
    state = _load_authorized(reconstruction_id, context_token, "approve")
    _assert_profile_current(state, context_token)
    validation = validate_reconstruction(
        reconstruction_id,
        context_token=context_token,
    )
    if validation["summary"]["blocker"]:
        raise ReconstructionGateError(validation)
    if validation["summary"]["warning"] and not acknowledge_warnings:
        raise ReconstructionGateError(validation)
    state = _load_authorized(reconstruction_id, context_token, "approve")
    state["status"] = "approved"
    state["acknowledged_warnings"] = bool(acknowledge_warnings)
    _save_state(reconstruction_id, state)
    report = VoucherReconstructionReport.model_validate(state["report"])
    _notify_node(
        context_token,
        reconstruction_id,
        "approved",
        _node_summary(report),
        latest_draft_revision=state.get("latest_revision", 0),
    )
    return {
        "approved": True,
        "status": "approved",
        "validation": validation,
    }


def export_reconstruction(
    reconstruction_id: str,
    *,
    context_token: str,
    acknowledge_warnings: bool,
    idempotency_key: str,
) -> tuple[bytes, str, str]:
    started_at = time.perf_counter()
    state = _load_authorized(reconstruction_id, context_token, "export")
    _assert_profile_current(state, context_token)
    if os.getenv("RECONSTRUCTION_SHADOW_MODE", "false").lower() == "true":
        raise ValueError("Shadow mode chỉ phân tích, chưa cho phép export")
    if state.get("status") not in {"approved", "exported"}:
        raise ValueError("Phiên tái tạo phải được phê duyệt trước khi export")
    validation = validate_reconstruction(
        reconstruction_id,
        context_token=context_token,
    )
    if validation["summary"]["blocker"]:
        raise ReconstructionGateError(validation)
    if validation["summary"]["warning"] and not (
        acknowledge_warnings or state.get("acknowledged_warnings")
    ):
        raise ReconstructionGateError(validation)
    content, filename, media_type = export_template_rows(
        validation,
        reconstruction_id=reconstruction_id,
        acknowledged_warnings=bool(
            acknowledge_warnings or state.get("acknowledged_warnings")
        ),
    )
    state = _load_authorized(reconstruction_id, context_token, "export")
    state["status"] = "exported"
    state["last_export"] = {
        "idempotency_key_hash": _value_hash(idempotency_key),
        "filename": filename,
        "content_hash": hashlib.sha256(content).hexdigest(),
    }
    state["metrics"] = {
        **(state.get("metrics") or {}),
        "export_duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        "export_success": True,
        "output_file_count": len(validation.get("templates") or {}),
    }
    _save_state(reconstruction_id, state)
    report = VoucherReconstructionReport.model_validate(state["report"])
    _notify_node(
        context_token,
        reconstruction_id,
        "exported",
        _node_summary(report),
        latest_draft_revision=state.get("latest_revision", 0),
        idempotency_key=idempotency_key,
        metrics=state["metrics"],
    )
    return content, filename, media_type


def _load_authorized(
    reconstruction_id: str,
    context_token: str,
    required_scope: str,
) -> dict[str, Any]:
    _require_enabled()
    claims = verify_reconstruction_context_token(
        context_token,
        required_scope=required_scope,
    )
    if str(claims["run_id"]) != str(reconstruction_id):
        raise ReconstructionConflictError("Reconstruction context không khớp run")
    state = get_reconstruction_store().load(reconstruction_id)
    expected_hash = hashlib.sha256(context_token.encode("utf-8")).hexdigest()
    if state.get("context_token_hash") != expected_hash:
        raise ReconstructionConflictError("Reconstruction context đã thay đổi")
    return state


def _save_state(
    reconstruction_id: str,
    state: dict[str, Any],
    *,
    initial: bool = False,
) -> None:
    try:
        get_reconstruction_store().save(
            reconstruction_id,
            state,
            expected_state_revision=(
                None if initial else int(state.get("state_revision") or 0)
            ),
        )
    except ReconstructionStoreConflictError as exc:
        raise ReconstructionConflictError(str(exc)) from exc


def _apply_operation(draft: VoucherDraft, operation: dict[str, Any]) -> dict[str, Any]:
    op = str(operation.get("op") or "")
    before: Any = None
    after: Any = None
    field_path = ""
    if op == "set_type":
        value = str(operation.get("value") or "")
        direction, nature = {
            "purchase_goods": ("purchase", "goods"),
            "purchase_services": ("purchase", "service"),
            "sales_goods": ("sales", "goods"),
            "sales_services": ("sales", "service"),
        }.get(value, (None, None))
        if not direction:
            raise ValueError("Loại chứng từ không hợp lệ")
        before = f"{draft.direction}_{draft.nature}"
        draft.direction = direction
        draft.direction_trust = "verified"
        draft.nature = nature
        draft.nature_trust = "verified"
        draft.document_kind = value
        draft.template_id = {
            "purchase_goods": "misa_purchase_domestic",
            "purchase_services": "purchase_service",
            "sales_goods": "bsn_sales",
            "sales_services": "sales_service",
        }[value]
        after = value
    elif op == "set_field":
        path = str(operation.get("path") or "")
        field_path = path
        if path.startswith("header."):
            name = path.split(".", 1)[1]
            field = draft.header.get(name)
            before = field.value if field else None
            draft.header[name] = _manual_field(operation.get("value"))
            after = operation.get("value")
            draft.issues = [
                issue
                for issue in draft.issues
                if not (issue.field == name and issue.code == "invoice_header_conflict")
            ]
        elif path.startswith("lines."):
            parts = path.split(".")
            if len(parts) != 4 or parts[2] != "fields":
                raise ValueError("Field path của line không hợp lệ")
            line = next((item for item in draft.lines if item.id == parts[1]), None)
            if not line:
                raise KeyError(f"Không tìm thấy line {parts[1]}")
            name = parts[3]
            field = line.fields.get(name)
            before = field.value if field else None
            line.fields[name] = _manual_field(operation.get("value"))
            after = operation.get("value")
        else:
            raise ValueError("Field path không được hỗ trợ")
    else:
        raise ValueError(f"Operation không được hỗ trợ: {op}")
    return {
        "draftStableId": draft.id,
        "draftRevision": draft.revision,
        "operationType": op,
        "fieldPath": field_path,
        "beforeHash": _value_hash(before),
        "afterHash": _value_hash(after),
        "structuralRule": {},
        "sourceRows": draft.source_rows,
    }


def _manual_field(value: Any) -> VoucherField:
    return VoucherField(
        value=value,
        trust="verified",
        provenance=[FieldProvenance(source="manual", references=[])],
    )


def _refresh_draft(draft: VoucherDraft) -> None:
    line_natures = {line.nature for line in draft.lines if line.nature != "unknown"}
    if len(line_natures) > 1:
        draft.nature = "mixed"
        draft.nature_trust = "conflict"
    elif len(line_natures) == 1 and draft.nature not in {"goods", "service"}:
        draft.nature = next(iter(line_natures))
        draft.nature_trust = "suggested"
    amount = sum((_decimal(line.fields.get("amount")) for line in draft.lines), Decimal("0"))
    discount = sum(
        (_decimal(line.fields.get("discount_amount")) for line in draft.lines),
        Decimal("0"),
    )
    vat = sum((_decimal(line.fields.get("vat_amount")) for line in draft.lines), Decimal("0"))
    draft.totals.amount = _decimal_text(amount)
    draft.totals.discount = _decimal_text(discount)
    draft.totals.vat = _decimal_text(vat)
    draft.totals.payment = _decimal_text(amount + vat)
    draft.source_rows = sorted(set(draft.source_rows))
    draft.status = (
        "blocked"
        if any(issue.severity == "blocker" for issue in draft.issues)
        else "needs_review"
        if any(issue.severity == "warning" for issue in draft.issues)
        or draft.nature in {"mixed", "unknown"}
        or draft.direction == "unknown"
        else "ready"
    )


def _refresh_report(report: VoucherReconstructionReport) -> None:
    for draft in report.drafts:
        _refresh_draft(draft)
    report.summary.draft_count = len(report.drafts)
    report.summary.ready = sum(draft.status == "ready" for draft in report.drafts)
    report.summary.needs_review = sum(
        draft.status == "needs_review" for draft in report.drafts
    )
    report.summary.blocked = sum(draft.status == "blocked" for draft in report.drafts)
    report.summary.purchase_goods = sum(
        draft.direction == "purchase" and draft.nature == "goods"
        for draft in report.drafts
    )
    report.summary.purchase_services = sum(
        draft.direction == "purchase" and draft.nature == "service"
        for draft in report.drafts
    )
    report.summary.sales_goods = sum(
        draft.direction == "sales" and draft.nature == "goods"
        for draft in report.drafts
    )
    report.summary.sales_services = sum(
        draft.direction == "sales" and draft.nature == "service"
        for draft in report.drafts
    )
    report.summary.mixed = sum(draft.nature == "mixed" for draft in report.drafts)
    report.summary.unknown = sum(
        draft.nature == "unknown" or draft.direction == "unknown"
        for draft in report.drafts
    )
    assigned = len({row for draft in report.drafts for row in draft.source_rows})
    report.row_conservation.assigned_rows = assigned
    report.row_conservation.unresolved_rows = max(
        0,
        report.row_conservation.source_rows
        - assigned
        - report.row_conservation.ignored_rows,
    )


def _merge_headers(target: VoucherDraft, source: VoucherDraft) -> None:
    for name, source_field in source.header.items():
        target_field = target.header.get(name)
        if not target_field or target_field.value in (None, ""):
            target.header[name] = source_field
            continue
        if source_field.value in (None, ""):
            continue
        if str(target_field.value).strip() != str(source_field.value).strip():
            raise ValueError(f"Không thể merge vì header '{name}' xung đột")


def _master_data_context(
    claims: dict[str, Any],
    context_token: str,
) -> tuple[dict[str, Any] | None, str, str | None]:
    if not claims.get("workspace_id"):
        return None, "not_configured", "Chưa chọn hồ sơ doanh nghiệp"
    try:
        return fetch_master_data_context(context_token), "connected", None
    except ConversionContextError as exc:
        raise ValueError(str(exc)) from exc


def _refresh_current_context(state: dict[str, Any], context_token: str) -> None:
    claims = state.get("context_claims") or {}
    if not claims.get("workspace_id"):
        return
    state["master_data_context"] = fetch_master_data_context(context_token)
    state["context_status"] = "connected"
    state["context_message"] = None


def _assert_profile_current(state: dict[str, Any], context_token: str) -> None:
    profile = state.get("profile") or {}
    profile_id = str(profile.get("id") or "")
    if not profile_id:
        return
    try:
        assert_reconstruction_profile_current(
            context_token,
            profile_id=profile_id,
            version=int(profile.get("version") or 0),
        )
    except ReconstructionProfileClientError as exc:
        raise ReconstructionConflictError(str(exc)) from exc


def _profile_column_mapping(profile: dict[str, Any] | None) -> dict[str, str] | None:
    roles = (profile or {}).get("fieldRoles")
    if not isinstance(roles, dict):
        return None
    output: dict[str, str] = {}
    canonical_to_semantic = {
        "invoice_number": "invoice",
        "posting_date": "date",
        "amount": "line_amount",
        "discount_rate": "discount_percent",
        "discount_amount": "discount_amount",
    }
    for key, value in roles.items():
        if not isinstance(value, str):
            continue
        if key in {
            "invoice",
            "invoice_symbol",
            "invoice_date",
            "date",
            "supplier_code",
            "supplier_tax_code",
            "supplier_name",
            "customer_code",
            "customer_tax_code",
            "customer_name",
            "item_code",
            "item_name",
            "item_type",
            "unit",
            "quantity",
            "unit_price",
            "line_amount",
            "vat_rate",
            "vat_amount",
        }:
            output[key] = value
        else:
            output[canonical_to_semantic.get(value, value)] = key
    return output or None


def _enforce_draft_limit(report: VoucherReconstructionReport) -> None:
    limit = max(1, int(os.getenv("RECONSTRUCTION_MAX_DRAFTS", "10000")))
    if report.summary.draft_count > limit:
        raise ValueError(f"File tạo ra quá {limit} chứng từ; vui lòng chia nhỏ file")


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _report_payload(
    report: VoucherReconstructionReport,
    reconstruction_id: str,
    profile: dict[str, Any] | None,
    *,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = report.model_dump(mode="json")
    payload["reconstruction_id"] = reconstruction_id
    payload["profile"] = profile
    for key in ("profile_warning", "ai", "structure", "metrics"):
        if key in (previous or {}):
            payload[key] = previous[key]
    return payload


def _node_summary(report: VoucherReconstructionReport) -> dict[str, Any]:
    return {
        "inputSheets": 1,
        "inputRows": report.row_conservation.source_rows,
        "draftCount": report.summary.draft_count,
        "ready": report.summary.ready,
        "review": report.summary.needs_review,
        "blocked": report.summary.blocked,
        "classification": {
            "purchase_goods": report.summary.purchase_goods,
            "purchase_services": report.summary.purchase_services,
            "sales_goods": report.summary.sales_goods,
            "sales_services": report.summary.sales_services,
            "mixed": report.summary.mixed,
            "unknown": report.summary.unknown,
        },
        "reconciliation": report.row_conservation.model_dump(mode="json"),
    }


def _notify_node(
    context_token: str,
    reconstruction_id: str,
    event: str,
    summary: dict[str, Any],
    **extra: Any,
) -> None:
    if os.getenv("RECONSTRUCTION_NOTIFY_NODE", "true").strip().lower() == "false":
        return
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-reconstruction-context": context_token}
    token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if token:
        headers["x-converter-service-token"] = token
    payload = {"event": event, "summary": summary, **_camel_case_extra(extra)}
    try:
        response = httpx.post(
            f"{base_url}/reconstructions/{reconstruction_id}/events",
            json=payload,
            headers=headers,
            timeout=float(os.getenv("NODE_INTERNAL_TIMEOUT_SECONDS", "15")),
        )
        response.raise_for_status()
    except httpx.HTTPError:
        if os.getenv("RECONSTRUCTION_NODE_REQUIRED", "false").lower() == "true":
            raise


def _camel_case_extra(values: dict[str, Any]) -> dict[str, Any]:
    mapping = {
        "source_file_hash": "sourceFileHash",
        "source_signature_hash": "sourceSignatureHash",
        "latest_draft_revision": "latestDraftRevision",
        "idempotency_key": "idempotencyKey",
        "metrics": "metrics",
        "profile_id": "profileId",
        "profile_version": "profileVersion",
    }
    return {mapping.get(key, key): value for key, value in values.items()}


def _require_enabled() -> None:
    if os.getenv("VOUCHER_RECONSTRUCTION_ENABLED", "false").strip().lower() != "true":
        raise ValueError("Tính năng tái tạo chứng từ đang tắt")


def _derived_draft_id(seed: str, source_rows: list[int]) -> str:
    return hashlib.sha256(
        json.dumps([seed, sorted(source_rows)], sort_keys=True).encode("utf-8")
    ).hexdigest()[:24]


def _value_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _decimal(field: Any) -> Decimal:
    value = getattr(field, "value", None) if field is not None else None
    if value in (None, ""):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return Decimal("0")


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))
    return format(normalized, "f")
