from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.document_structure import validate_excel_magic
from app.excel_io import InputTable, read_input_table
from app.normalization import normalize_header
from app.operation_models import ReconciliationReportV2, ReconciliationSummaryV2
from app.operation_store import OperationStore, OperationStoreError
from app.parsing import parse_decimal


class ReconciliationFeatureDisabledError(OperationStoreError):
    pass


COMPARISON_ROLES = {
    "invoice_export",
    "internal_ledger",
    "payment_list",
    "inventory_list",
    "other",
}
_ALIASES = {
    "stable_id": {"source_document_id", "document_id", "id_chung_tu", "id_hoa_don"},
    "seller_tax_code": {"mst_nguoi_ban", "ma_so_thue_nguoi_ban", "mst_ncc", "ma_so_thue"},
    "invoice_symbol": {"ky_hieu", "ky_hieu_hoa_don", "mau_so_ky_hieu"},
    "invoice_number": {"so_hoa_don", "so_hd", "so_chung_tu", "so_ct"},
    "date": {"ngay_hoa_don", "ngay_chung_tu", "ngay_ct"},
    "counterparty": {"ten_nha_cung_cap", "nha_cung_cap", "ten_nguoi_ban", "doi_tuong"},
    "total": {"tong_tien", "tong_thanh_toan", "tong_cong", "tien_thanh_toan"},
    "currency": {"loai_tien", "tien_te", "currency", "ma_tien_te"},
    "quantity": {"so_luong", "quantity", "sl"},
}
_REPORT_LOCKS: dict[str, threading.RLock] = {}
_REPORT_LOCKS_GUARD = threading.Lock()


def reconciliation_enabled() -> bool:
    return os.getenv("FEATURE_RECONCILIATION", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def add_comparison_file(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
    filename: str,
    content: bytes,
    role: str,
) -> dict[str, Any]:
    _require_enabled()
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    if role not in COMPARISON_ROLES:
        raise OperationStoreError("Vai trò file đối chiếu không hợp lệ")
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise OperationStoreError("Chỉ hỗ trợ file đối chiếu .xls và .xlsx")
    if len(content) > _positive_env_int("RECONCILIATION_MAX_FILE_BYTES", 30 * 1024 * 1024):
        raise OperationStoreError("File đối chiếu vượt giới hạn dung lượng")
    metadata = _comparison_metadata(store, session_id)
    comparison_limit = min(
        2, _positive_env_int("RECONCILIATION_MAX_COMPARISON_FILES", 2)
    )
    if len(metadata) >= comparison_limit:
        raise OperationStoreError("Mỗi phiên chỉ nhận tối đa hai file đối chiếu")
    if any(item.get("role") == role for item in metadata):
        raise OperationStoreError("Vai trò đối chiếu đã được sử dụng")
    validate_excel_magic(filename, content)
    file_id = str(uuid.uuid4())
    directory = store.root / session_id / "comparisons"
    directory.mkdir(parents=True, exist_ok=True)
    temporary_raw = directory / f"{file_id}.upload{suffix}"
    final_raw = directory / f"{file_id}{suffix}"
    parsed_path = directory / f"{file_id}.json"
    try:
        temporary_raw.write_bytes(content)
        table = read_input_table(temporary_raw)
        if not table.headers:
            raise OperationStoreError("Không phát hiện được header file đối chiếu")
        if len(table.rows) > _positive_env_int("RECONCILIATION_MAX_ROWS", 50000):
            raise OperationStoreError("File đối chiếu vượt giới hạn số dòng")
        if len(table.headers) > _positive_env_int("RECONCILIATION_MAX_COLUMNS", 500):
            raise OperationStoreError("File đối chiếu vượt giới hạn số cột")
        parsed = _table_payload(table)
        temporary_parsed = parsed_path.with_suffix(".tmp")
        temporary_parsed.write_text(
            json.dumps(parsed, ensure_ascii=False, sort_keys=True, default=str),
            encoding="utf-8",
        )
        temporary_raw.replace(final_raw)
        temporary_parsed.replace(parsed_path)
    except Exception:
        temporary_raw.unlink(missing_ok=True)
        final_raw.unlink(missing_ok=True)
        parsed_path.unlink(missing_ok=True)
        raise
    item = {
        "file_id": file_id,
        "filename": Path(filename).name,
        "role": role,
        "sha256": hashlib.sha256(content).hexdigest(),
        "row_count": len(table.rows),
    }
    metadata.append(item)
    _write_comparison_metadata(store, session_id, metadata)
    return item


def remove_comparison_file(
    store: OperationStore,
    *,
    session_id: str,
    file_id: str,
    revision: int,
    state_hash: str,
) -> None:
    _require_enabled()
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    metadata = _comparison_metadata(store, session_id)
    target = next((item for item in metadata if item.get("file_id") == file_id), None)
    if target is None:
        raise OperationStoreError("File đối chiếu không tồn tại")
    metadata = [item for item in metadata if item.get("file_id") != file_id]
    directory = store.root / session_id / "comparisons"
    for path in directory.glob(f"{file_id}*"):
        path.unlink(missing_ok=True)
    _write_comparison_metadata(store, session_id, metadata)


def run_reconciliation(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
) -> dict[str, Any]:
    _require_enabled()
    session = store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    comparisons = _comparison_metadata(store, session_id)
    if not comparisons:
        return ReconciliationReportV2(
            report_id=str(uuid.uuid4()),
            session_id=session_id,
            revision=revision,
            status="not_run",
            roles_present=["primary"],
            state_hash=session.state_hash,
        ).model_dump(mode="json")

    primary = _records(store.materialize_table(session_id, revision=revision))
    comparison_records = [
        (item, _records(_load_comparison_table(store, session_id, item["file_id"])))
        for item in comparisons
    ]
    records: list[dict[str, Any]] = []
    usable_evidence = any(
        item.get("match_key") or item.get("candidate_key") for item in primary
    )

    for metadata, source_records in comparison_records:
        strong_index = _index_records(source_records)
        candidate_index = _candidate_index(source_records)
        used_source: set[str] = set()
        usable_evidence = usable_evidence and bool(strong_index or candidate_index)
        for primary_record in primary:
            key, candidates_for_key = _strong_matches(primary_record, strong_index)
            if not key:
                candidate_key = primary_record.get("candidate_key")
                candidate_matches = candidate_index.get(str(candidate_key), []) if candidate_key else []
                if candidate_matches:
                    comparison_record_ids = [
                        source["record_id"] for source in candidate_matches
                    ]
                    match_id = uuid.uuid4().hex
                    records.append(
                        {
                            "match_id": match_id,
                            "status": "candidate",
                            "role": metadata["role"],
                            "primary_record_id": primary_record["record_id"],
                            "comparison_record_id": (
                                comparison_record_ids[0]
                                if len(comparison_record_ids) == 1
                                else None
                            ),
                            "comparison_record_ids": comparison_record_ids,
                            "comparison_options": [
                                _candidate_option(source) for source in candidate_matches
                            ],
                            "label": _business_label(primary_record),
                            "evidence": _business_evidence(primary_record),
                            "reason": "invoice_date_counterparty_total",
                        }
                    )
                    continue
                records.append(
                    {
                        "status": "missing_comparison",
                        "role": metadata["role"],
                        "primary_record_id": primary_record["record_id"],
                    }
                )
                continue
            if len(candidates_for_key) != 1:
                records.append(
                    {
                        "status": "conflict",
                        "role": metadata["role"],
                        "primary_record_id": primary_record["record_id"],
                        "reason": "duplicate_strong_key",
                    }
                )
                continue
            source = candidates_for_key[0]
            used_source.add(source["record_id"])
            amount_tolerance = _amount_tolerance(primary_record, source)
            quantity_tolerance = Decimal("0.000001")
            amount_delta = _amount_delta(primary_record.get("total"), source.get("total"))
            quantity_delta = _amount_delta(
                primary_record.get("quantity"), source.get("quantity")
            )
            currency_conflict = bool(
                primary_record.get("currency")
                and source.get("currency")
                and primary_record.get("currency") != source.get("currency")
            )
            if (
                primary_record.get("total_conflict")
                or source.get("total_conflict")
                or primary_record.get("total_unusable")
                or source.get("total_unusable")
                or currency_conflict
                or (amount_delta is not None and abs(amount_delta) > amount_tolerance)
                or (
                    quantity_delta is not None
                    and abs(quantity_delta) > quantity_tolerance
                )
            ):
                records.append(
                    {
                        "status": "conflict",
                        "role": metadata["role"],
                        "primary_record_id": primary_record["record_id"],
                        "comparison_record_id": source["record_id"],
                        "amount_delta": str(amount_delta) if amount_delta is not None else None,
                        "amount_tolerance": str(amount_tolerance),
                        "quantity_delta": (
                            str(quantity_delta) if quantity_delta is not None else None
                        ),
                        "quantity_tolerance": str(quantity_tolerance),
                        "currency_conflict": currency_conflict,
                        "reason": (
                            "total_unavailable"
                            if primary_record.get("total_unusable")
                            or source.get("total_unusable")
                            else "amount_or_currency_mismatch"
                        ),
                    }
                )
                continue
            records.append(
                {
                    "status": "matched",
                    "role": metadata["role"],
                    "primary_record_id": primary_record["record_id"],
                    "comparison_record_id": source["record_id"],
                    "rounding_notice": bool(amount_delta or quantity_delta),
                    "amount_tolerance": str(amount_tolerance),
                    "quantity_tolerance": str(quantity_tolerance),
                }
            )
        unmatched = [
            item for item in source_records if item["record_id"] not in used_source
        ]
        for item in unmatched:
            records.append(
                {
                    "status": "missing_primary",
                    "role": metadata["role"],
                    "comparison_record_id": item["record_id"],
                    "label": _business_label(item),
                    "evidence": _business_evidence(item),
                }
            )

    summary = _summary_from_records(records)
    status = _report_status(
        usable_evidence=usable_evidence,
        comparison_count=len(comparisons),
        conflicts=summary["conflicts"],
        missing_primary=summary["missing_primary"],
        missing_comparison=summary["missing_comparison"],
        candidates_need_review=summary["candidates_need_review"],
    )
    report = ReconciliationReportV2(
        report_id=str(uuid.uuid4()),
        session_id=session_id,
        revision=revision,
        status=status,
        roles_present=["primary", *[item["role"] for item in comparisons]],
        summary=ReconciliationSummaryV2.model_validate(summary),
        records=records,
        tolerances={"VND": "1", "foreign_currency": "0.01", "quantity": "0.000001"},
        state_hash=session.state_hash,
    ).model_dump(mode="json")
    _write_report(store, session_id, report)
    return report


def get_reconciliation_report(
    store: OperationStore, *, session_id: str, report_id: str
) -> dict[str, Any]:
    store.load_session(session_id)
    path = store.root / session_id / f"reconciliation-{report_id}.json"
    if not path.exists():
        raise OperationStoreError("Báo cáo đối chiếu không tồn tại")
    return json.loads(path.read_text(encoding="utf-8"))


def confirm_candidate_match(
    store: OperationStore,
    *,
    session_id: str,
    report_id: str,
    match_id: str,
    revision: int,
    state_hash: str,
    confirmed_by: str,
    selected_comparison_record_id: str | None = None,
    action: str = "confirm",
) -> dict[str, Any]:
    _require_enabled()
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    with _report_lock(session_id, report_id):
        return _review_candidate_match(
            store,
            session_id=session_id,
            report_id=report_id,
            match_id=match_id,
            revision=revision,
            state_hash=state_hash,
            confirmed_by=confirmed_by,
            selected_comparison_record_id=selected_comparison_record_id,
            action=action,
        )


def _review_candidate_match(
    store: OperationStore,
    *,
    session_id: str,
    report_id: str,
    match_id: str,
    revision: int,
    state_hash: str,
    confirmed_by: str,
    selected_comparison_record_id: str | None,
    action: str,
) -> dict[str, Any]:
    report = get_reconciliation_report(
        store, session_id=session_id, report_id=report_id
    )
    if int(report.get("revision") or 0) != revision or report.get("state_hash") != state_hash:
        raise OperationStoreError("Báo cáo đối chiếu không thuộc revision hiện tại")
    record = next(
        (item for item in report.get("records") or [] if item.get("match_id") == match_id),
        None,
    )
    if record is None or record.get("status") != "candidate":
        raise OperationStoreError("Candidate match không tồn tại hoặc đã được xử lý")
    normalized_action = str(action or "confirm").strip().lower()
    if normalized_action not in {"confirm", "reject", "defer"}:
        raise OperationStoreError("Hành động rà soát candidate không hợp lệ")
    options = [str(item) for item in record.get("comparison_record_ids") or []]
    if normalized_action == "confirm":
        selected = selected_comparison_record_id or record.get("comparison_record_id")
        if not selected or selected not in options:
            raise OperationStoreError("Cần chọn bản ghi đối chiếu cụ thể cho candidate mơ hồ")
        if any(
            item is not record
            and item.get("role") == record.get("role")
            and item.get("comparison_record_id") == selected
            and item.get("status") in {"matched", "confirmed_candidate", "conflict"}
            for item in report.get("records") or []
        ):
            raise OperationStoreError("Bản ghi đối chiếu đã được ghép hoặc đang xung đột")
        record["status"] = "confirmed_candidate"
        record["comparison_record_id"] = selected
        report["records"] = [
            item
            for item in report.get("records") or []
            if not (
                item.get("status") == "missing_primary"
                and item.get("role") == record.get("role")
                and item.get("comparison_record_id") == selected
            )
        ]
    elif normalized_action == "reject":
        record["status"] = "rejected_candidate"
        record["comparison_record_id"] = None
    else:
        record["status"] = "deferred_candidate"
        record["comparison_record_id"] = None
    record["reviewed_by"] = confirmed_by
    record["review_action"] = normalized_action
    summary = _summary_from_records(report.get("records") or [])
    report["summary"] = summary
    report["status"] = _report_status(
        usable_evidence=True,
        comparison_count=max(0, len(report.get("roles_present") or []) - 1),
        conflicts=(
            summary["conflicts"]
            + summary["rejected_candidates"]
            + summary["deferred_candidates"]
        ),
        missing_primary=summary["missing_primary"],
        missing_comparison=summary["missing_comparison"],
        candidates_need_review=summary["candidates_need_review"],
    )
    record["report_summary"] = dict(summary)
    record["report_status"] = report["status"]
    _write_report(store, session_id, report)
    return record


def _records(table: InputTable) -> list[dict[str, Any]]:
    field_map = _field_map(table.headers)
    grouped: dict[str, dict[str, Any]] = {}
    unresolved = 0
    for row_offset, row in enumerate(table.rows, start=1):
        invoice_display = _display_text(row.get(field_map.get("invoice_number", "")))
        date_display = _display_text(row.get(field_map.get("date", "")))
        counterparty_display = _display_text(row.get(field_map.get("counterparty", "")))
        currency_display = _display_text(row.get(field_map.get("currency", "")))
        stable_id = _normalized(row.get(field_map.get("stable_id", "")))
        tax_code = _digits(row.get(field_map.get("seller_tax_code", "")))
        symbol = _normalized(row.get(field_map.get("invoice_symbol", "")))
        invoice = _normalized(invoice_display)
        stable_key = f"stable:{stable_id}" if stable_id else None
        invoice_key = (
            f"invoice:{tax_code}|{symbol}|{invoice}"
            if tax_code and symbol and invoice
            else None
        )
        record_key = stable_key or invoice_key or f"unresolved:{unresolved}"
        unresolved += not bool(stable_key or invoice_key)
        current = grouped.setdefault(
            record_key,
            {
                "record_id": hashlib.sha256(record_key.encode("utf-8")).hexdigest()[:20],
                "match_key": stable_key or invoice_key,
                "strong_keys": [key for key in (stable_key, invoice_key) if key],
                "candidate_key": None,
                "total": None,
                "total_values": [],
                "total_conflict": False,
                "total_unusable": False,
                "quantity": None,
                "currency": _normalized(currency_display) or None,
                "invoice_number": invoice or None,
                "date": _normalized(date_display) or None,
                "counterparty": _normalized(counterparty_display) or None,
                "invoice_number_display": invoice_display or None,
                "date_display": date_display or None,
                "counterparty_display": counterparty_display or None,
                "currency_display": currency_display or None,
                "source_rows": [],
            },
        )
        source_row = int(table.header_row_index or 0) + row_offset + 1
        if source_row not in current["source_rows"]:
            current["source_rows"].append(source_row)
        for key in (stable_key, invoice_key):
            if key and key not in current["strong_keys"]:
                current["strong_keys"].append(key)
        total_field = field_map.get("total")
        raw_total = row.get(total_field) if total_field else None
        parsed_total = _parse_reconciliation_decimal(raw_total)
        if parsed_total is not None:
            current["total_values"].append(parsed_total)
        else:
            current["total_unusable"] = True
        parsed_quantity = _parse_reconciliation_decimal(
            row.get(field_map.get("quantity", ""))
        )
        if parsed_quantity is not None:
            current["quantity"] = (current["quantity"] or Decimal("0")) + parsed_quantity
    output = list(grouped.values())
    for current in output:
        distinct_totals = list(dict.fromkeys(current.pop("total_values")))
        if distinct_totals:
            current["total"] = distinct_totals[0]
            current["total_conflict"] = len(distinct_totals) > 1
        if (
            current.get("invoice_number")
            and current.get("date")
            and current.get("counterparty")
            and current.get("total") is not None
        ):
            current["candidate_key"] = (
                f"candidate:{current['invoice_number']}|{current['date']}|"
                f"{current['counterparty']}|{current['total']}"
            )
    return output


def _index_records(records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        for key in record.get("strong_keys") or []:
            index.setdefault(str(key), []).append(record)
    return index


def _strong_matches(
    record: dict[str, Any], index: dict[str, list[dict[str, Any]]]
) -> tuple[str | None, list[dict[str, Any]]]:
    for key in record.get("strong_keys") or []:
        matches = index.get(str(key), [])
        if matches:
            return str(key), matches
    return None, []


def _candidate_index(records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        key = record.get("candidate_key")
        if key:
            index.setdefault(str(key), []).append(record)
    return index


def _candidate_option(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_id": record["record_id"],
        "label": _business_label(record),
        "evidence": _business_evidence(record),
    }


def _business_label(record: dict[str, Any]) -> str:
    evidence = _business_evidence(record)
    parts = [
        evidence.get("invoice_number"),
        evidence.get("date"),
        evidence.get("counterparty"),
        evidence.get("total"),
    ]
    rows = evidence.get("source_rows") or []
    if rows:
        row_label = str(rows[0]) if len(rows) == 1 else f"{rows[0]}-{rows[-1]}"
        parts.append(f"dòng {row_label}")
    return " · ".join(str(part) for part in parts if part not in {None, ""}) or "Bản ghi đối chiếu"


def _business_evidence(record: dict[str, Any]) -> dict[str, Any]:
    total = record.get("total")
    return {
        "invoice_number": record.get("invoice_number_display")
        or record.get("invoice_number"),
        "date": record.get("date_display") or record.get("date"),
        "counterparty": record.get("counterparty_display")
        or record.get("counterparty"),
        "total": str(total) if total is not None else None,
        "currency": record.get("currency_display") or record.get("currency"),
        "source_rows": list(record.get("source_rows") or []),
    }


def _field_map(headers: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for header in headers:
        normalized = normalize_header(header)
        for semantic, aliases in _ALIASES.items():
            if normalized in aliases and semantic not in result:
                result[semantic] = header
    return result


def _amount_delta(left: Any, right: Any):
    if left is None or right is None:
        return None
    return left - right


def _parse_reconciliation_decimal(value: Any) -> Decimal | None:
    if not isinstance(value, str):
        return parse_decimal(value)
    text = (
        value.strip()
        .replace("₫", "")
        .replace("VND", "")
        .replace("VNĐ", "")
        .replace(" ", "")
        .replace("\u00a0", "")
    )
    if not text:
        return None
    if text.startswith("(") and text.endswith(")"):
        text = f"-{text[1:-1]}"
    valid = re.fullmatch(
        r"[+-]?(?:"
        r"\d+(?:[.,]\d+)?|"
        r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|"
        r"\d{1,3}(?:\.\d{3})+(?:,\d+)?"
        r")",
        text,
    )
    return parse_decimal(text) if valid else None


def _amount_tolerance(left: dict[str, Any], right: dict[str, Any]) -> Decimal:
    currency = str(left.get("currency") or right.get("currency") or "VND").upper()
    return Decimal("1") if currency in {"", "VND", "VNĐ"} else Decimal("0.01")


def _report_status(
    *,
    usable_evidence: bool,
    comparison_count: int,
    conflicts: int,
    missing_primary: int,
    missing_comparison: int,
    candidates_need_review: int,
) -> str:
    if not usable_evidence:
        return "insufficient_evidence"
    if conflicts or missing_primary or missing_comparison or candidates_need_review:
        return "conflict"
    return "complete" if comparison_count == 2 else "partial"


def _summary_from_records(records: list[dict[str, Any]]) -> dict[str, int]:
    statuses = [str(record.get("status") or "") for record in records]
    matched_primary_ids = {
        str(record.get("primary_record_id"))
        for record in records
        if record.get("status") in {"matched", "confirmed_candidate"}
        and record.get("primary_record_id")
    }
    return ReconciliationSummaryV2(
        # A primary row can match more than one optional comparison role. The
        # summary counts reconciled primary rows, not relationship records.
        matched=len(matched_primary_ids),
        missing_primary=statuses.count("missing_primary"),
        missing_comparison=statuses.count("missing_comparison"),
        conflicts=statuses.count("conflict"),
        candidates_need_review=statuses.count("candidate"),
        rejected_candidates=statuses.count("rejected_candidate"),
        deferred_candidates=statuses.count("deferred_candidate"),
    ).model_dump()


def _normalized(value: Any) -> str:
    return "".join(str(value or "").strip().upper().split())


def _display_text(value: Any) -> str:
    return str(value or "").strip()


def _digits(value: Any) -> str:
    return "".join(char for char in str(value or "") if char.isdigit())


def _table_payload(table: InputTable) -> dict[str, Any]:
    return {
        "headers": table.headers,
        "rows": table.rows,
        "sheet_name": table.sheet_name,
        "header_row_index": table.header_row_index,
    }


def _load_comparison_table(
    store: OperationStore, session_id: str, file_id: str
) -> InputTable:
    path = store.root / session_id / "comparisons" / f"{file_id}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("File đối chiếu đã hết hạn hoặc không hợp lệ") from exc
    return InputTable(
        headers=list(payload.get("headers") or []),
        rows=list(payload.get("rows") or []),
        sheet_name=payload.get("sheet_name"),
        header_row_index=int(payload.get("header_row_index") or 0),
    )


def _comparison_metadata(store: OperationStore, session_id: str) -> list[dict[str, Any]]:
    path = store.root / session_id / "comparison-files.json"
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("Metadata file đối chiếu không hợp lệ") from exc
    return list(payload) if isinstance(payload, list) else []


def _write_comparison_metadata(
    store: OperationStore, session_id: str, metadata: list[dict[str, Any]]
) -> None:
    path = store.root / session_id / "comparison-files.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(metadata, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)


def _write_report(store: OperationStore, session_id: str, report: dict[str, Any]) -> None:
    path = store.root / session_id / f"reconciliation-{report['report_id']}.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)


def _require_enabled() -> None:
    if not reconciliation_enabled():
        raise ReconciliationFeatureDisabledError("Reconciliation đang tắt")


def _report_lock(session_id: str, report_id: str) -> threading.RLock:
    key = f"{session_id}:{report_id}"
    with _REPORT_LOCKS_GUARD:
        return _REPORT_LOCKS.setdefault(key, threading.RLock())


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default
