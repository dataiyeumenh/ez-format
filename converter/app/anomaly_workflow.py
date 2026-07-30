from __future__ import annotations

import hashlib
import json
import os
import uuid
from decimal import Decimal
from pathlib import Path
from statistics import median
from typing import Any

from app.anomaly_rules import enabled_rule
from app.operation_models import ValidationIssueV2
from app.operation_store import OperationStore, OperationStoreError
from app.parsing import parse_decimal


class AnomalyFeatureDisabledError(OperationStoreError):
    pass


REVIEW_ACTIONS = {"confirmed_issue", "expected_value", "corrected", "deferred"}


def anomaly_detection_enabled() -> bool:
    return os.getenv("FEATURE_ANOMALY_DETECTION", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def detect_anomalies(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
    readiness_issues: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    _require_enabled()
    session = store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    # `readiness_issues` remains accepted for wire compatibility only. Client
    # findings are never evidence; deterministic issues are rebuilt server-side.
    _ = readiness_issues
    payload = evaluate_anomalies_for_table(
        store,
        session_id=session_id,
        revision=revision,
        state_hash=session.state_hash,
        table=store.materialize_table(session_id, revision=revision),
        context=store.context_for_revision(session_id, revision),
    )
    _write_payload(store, session_id, revision, payload)
    return payload


def evaluate_anomalies_for_table(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
    table: Any,
    context: dict[str, Any],
) -> dict[str, Any]:
    rows = [
        {"row_id": f"r{index}", "values": row}
        for index, row in enumerate(table.rows, start=1)
    ]
    issues = _deterministic_issues(
        session_id=session_id,
        revision=revision,
        table=table,
        context=context,
    )
    statistical_issues, statistical_evaluations = _statistical_issues(
        session_id,
        revision,
        rows,
        header_row_index=table.header_row_index,
    )
    issues.extend(statistical_issues)
    return {
        "run_id": str(uuid.uuid4()),
        "session_id": session_id,
        "revision": revision,
        "state_hash": state_hash,
        "issues": [issue.model_dump(mode="json") for issue in issues],
        "statistical_evaluations": statistical_evaluations,
        "reviews": {},
        "summary": {
            "fatal": sum(issue.severity == "fatal" for issue in issues),
            "blocker": sum(issue.severity == "blocker" for issue in issues),
            "warning": sum(issue.severity == "warning" for issue in issues),
            "info": sum(issue.severity == "info" for issue in issues),
            "export_blocking": sum(issue.blocking_scope == "export" for issue in issues),
        },
    }


def get_anomalies(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
) -> dict[str, Any]:
    store.load_session(session_id)
    return _read_payload(store, session_id, revision)


def review_anomaly(
    store: OperationStore,
    *,
    session_id: str,
    anomaly_id: str,
    revision: int,
    state_hash: str,
    action: str,
    reviewed_by: str,
) -> dict[str, Any]:
    _require_enabled()
    if action not in REVIEW_ACTIONS:
        raise OperationStoreError("Anomaly review action không hợp lệ")
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    payload = _read_payload(store, session_id, revision)
    issue = next((item for item in payload["issues"] if item["id"] == anomaly_id), None)
    if issue is None:
        raise OperationStoreError("Anomaly không tồn tại")
    if action == "expected_value" and issue.get("deterministic") and issue.get(
        "blocking_scope"
    ) != "none":
        raise OperationStoreError("Không thể bỏ qua deterministic blocker")
    payload.setdefault("reviews", {})[anomaly_id] = {
        "action": action,
        "reviewed_by": reviewed_by,
    }
    _write_payload(store, session_id, revision, payload)
    return payload["reviews"][anomaly_id]


def adapt_readiness_issue(
    session_id: str,
    revision: int,
    issue: dict[str, Any],
) -> ValidationIssueV2:
    severity = str(issue.get("severity") or "warning")
    if severity not in {"fatal", "blocker", "warning", "info"}:
        severity = "warning"
    blocking_scope = "export" if severity in {"fatal", "blocker"} else "none"
    row = issue.get("row")
    row_id = f"r{max(1, int(row) - 1)}" if isinstance(row, int) else None
    rule_id = str(issue.get("code") or "readiness_issue")
    field = str(issue.get("field") or "") or None
    issue_id = _stable_id(session_id, revision, rule_id, row_id, field)
    return ValidationIssueV2(
        id=issue_id,
        rule_id=rule_id,
        severity=severity,
        blocking_scope=blocking_scope,
        deterministic=True,
        row_id=row_id,
        row=row if isinstance(row, int) else None,
        field=field,
        actual=issue.get("actual"),
        expected=issue.get("expected"),
        evidence_ids=[f"evidence:{issue_id}"],
        correction_eligibility="forbidden" if blocking_scope != "none" else "review_required",
        message=str(issue.get("message") or rule_id),
        metadata={"category": issue.get("category")},
    )


def _statistical_issues(
    session_id: str,
    revision: int,
    rows: list[dict[str, Any]],
    *,
    header_row_index: int,
) -> tuple[list[ValidationIssueV2], list[dict[str, Any]]]:
    rule = enabled_rule("numeric_robust_outlier")
    headers = sorted(
        {
            str(header)
            for row in rows
            for header in (row.get("values") or {}).keys()
        }
    )
    output: list[ValidationIssueV2] = []
    evaluations: list[dict[str, Any]] = []
    normalized_headers = {header: _normalized_field(header) for header in headers}
    group_headers = [
        header
        for header in headers
        if normalized_headers[header]
        in {"ma_hang", "item_code", "ma_nha_cung_cap", "ma_khach_hang", "tien_te", "loai_tien"}
    ]
    for field in headers:
        normalized_field = normalized_headers[field]
        if not any(
            token in normalized_field
            for token in (
                "so_luong",
                "don_gia",
                "thanh_tien",
                "tong_tien",
                "tien_thue",
                "chiet_khau",
                "ty_gia",
            )
        ):
            continue
        groups: dict[tuple[str, ...], list[tuple[str, Decimal]]] = {}
        for row in rows:
            parsed = parse_decimal((row.get("values") or {}).get(field))
            if parsed is not None:
                key = tuple(
                    str((row.get("values") or {}).get(header) or "").strip().casefold()
                    for header in group_headers
                )
                groups.setdefault(key, []).append((str(row["row_id"]), parsed))
        for group_key, values in groups.items():
            evaluation = {
                "rule_id": rule.rule_id,
                "field": field,
                "group": list(group_key),
                "sample_size": len(values),
            }
            if len(values) < rule.minimum_sample_size:
                evaluations.append(
                    {
                        **evaluation,
                        "status": "not_evaluated",
                        "reason": "minimum_sample_size_not_met",
                    }
                )
                continue
            center = median([value for _, value in values])
            deviations = [abs(value - center) for _, value in values]
            mad = median(deviations)
            if mad == 0:
                evaluations.append(
                    {
                        **evaluation,
                        "status": "not_evaluated",
                        "reason": "zero_mad",
                    }
                )
                continue
            evaluations.append(
                {**evaluation, "status": "evaluated", "reason": None}
            )
            threshold = mad * Decimal("6")
            for row_id, value in values:
                if abs(value - center) <= threshold:
                    continue
                issue_id = _stable_id(session_id, revision, rule.rule_id, row_id, field)
                output.append(
                    ValidationIssueV2(
                        id=issue_id,
                        rule_id=rule.rule_id,
                        severity="warning",
                        blocking_scope="none",
                        deterministic=False,
                        row_id=row_id,
                        row=int(row_id[1:]) + header_row_index + 1,
                        field=field,
                        actual=str(value),
                        expected=str(center),
                        evidence_ids=[f"evidence:{issue_id}"],
                        correction_eligibility="review_required",
                        message=(
                            f"Giá trị tại {field} khác đáng kể so với trung vị của nhóm dữ liệu; "
                            "cần kiểm tra ngữ cảnh nghiệp vụ."
                        ),
                        metadata={
                            "median": str(center),
                            "mad": str(mad),
                            "threshold": str(threshold),
                            "sample_size": len(values),
                            "group": list(group_key),
                        },
                    )
                )
    return output, evaluations


def _normalized_field(value: str) -> str:
    from app.normalization import normalize_header

    return normalize_header(value)


def _deterministic_issues(
    *,
    session_id: str,
    revision: int,
    table: Any,
    context: dict[str, Any],
) -> list[ValidationIssueV2]:
    return [
        adapt_readiness_issue(session_id, revision, item)
        for item in _build_readiness_issues(table, context)
    ]


def _build_readiness_issues(
    table: Any, context: dict[str, Any]
) -> list[dict[str, Any]]:
    mapping = context.get("mapping")
    if not isinstance(mapping, dict) or not mapping:
        return []
    from app.misa_readiness import build_readiness_report

    report = build_readiness_report(
        table,
        str(context.get("target_template_id") or ""),
        mapping,
        context.get("defaults") or {},
        context.get("formulas") or {},
    )
    return [item.model_dump(mode="json") for item in report.issues]


def _require_enabled() -> None:
    if not anomaly_detection_enabled():
        raise AnomalyFeatureDisabledError("Anomaly Detection đang tắt")


def _stable_id(
    session_id: str,
    revision: int,
    rule_id: str,
    row_id: str | None,
    field: str | None,
) -> str:
    raw = f"{session_id}|{revision}|{rule_id}|{row_id or ''}|{field or ''}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _artifact_path(store: OperationStore, session_id: str, revision: int) -> Path:
    safe_id = "".join(char for char in session_id if char.isalnum() or char in {"-", "_"})
    if safe_id != session_id:
        raise OperationStoreError("Session ID không hợp lệ")
    return store.root / safe_id / f"anomalies-{revision}.json"


def _write_payload(
    store: OperationStore,
    session_id: str,
    revision: int,
    payload: dict[str, Any],
) -> None:
    path = _artifact_path(store, session_id, revision)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)


def _read_payload(
    store: OperationStore,
    session_id: str,
    revision: int,
) -> dict[str, Any]:
    path = _artifact_path(store, session_id, revision)
    if not path.exists():
        raise OperationStoreError("Chưa có kết quả anomaly cho revision này")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("Kết quả anomaly không hợp lệ") from exc
