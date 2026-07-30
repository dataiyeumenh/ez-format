from __future__ import annotations

import pytest

from app.anomaly_workflow import (
    AnomalyFeatureDisabledError,
    detect_anomalies,
    review_anomaly,
)
from app.excel_io import InputTable
from app.operation_store import OperationStore, OperationStoreConflictError


def _session(store: OperationStore):
    rows = [
        {"Mã hàng": "SP01", "Đơn giá": 100 + (index % 3), "Số lượng": 1}
        for index in range(24)
    ]
    rows.append({"Mã hàng": "SP01", "Đơn giá": 100000, "Số lượng": 1})
    return store.create_session(
        upload_id="upload-anomaly",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="template-v1",
        source_signature={"hash": "source-v1"},
        table=InputTable(headers=["Mã hàng", "Đơn giá", "Số lượng"], rows=rows),
        raw_sha256="raw-sha",
        ttl_seconds=3600,
    )


def test_anomaly_feature_defaults_disabled(tmp_path, monkeypatch):
    monkeypatch.delenv("FEATURE_ANOMALY_DETECTION", raising=False)
    store = OperationStore(tmp_path)
    session = _session(store)

    with pytest.raises(AnomalyFeatureDisabledError):
        detect_anomalies(
            store,
            session_id=session.session_id,
            revision=session.active_revision,
            state_hash=session.state_hash,
        )


def test_statistical_outlier_is_non_blocking_and_has_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)

    result = detect_anomalies(
        store,
        session_id=session.session_id,
        revision=session.active_revision,
        state_hash=session.state_hash,
    )

    outliers = [issue for issue in result["issues"] if issue["rule_id"] == "numeric_robust_outlier"]
    assert len(outliers) == 1
    assert outliers[0]["severity"] == "warning"
    assert outliers[0]["blocking_scope"] == "none"
    assert outliers[0]["deterministic"] is False
    assert outliers[0]["evidence_ids"]


def test_review_rejects_stale_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    result = detect_anomalies(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    issue = result["issues"][0]
    derived = store.create_revision(
        session.session_id,
        expected_revision=1,
        expected_state_hash=session.state_hash,
        changes={"r1": {"Mã hàng": "SP02"}},
        created_by="user:user-1",
        activate=True,
    )

    with pytest.raises(OperationStoreConflictError):
        review_anomaly(
            store,
            session_id=session.session_id,
            anomaly_id=issue["id"],
            revision=1,
            state_hash=session.state_hash,
            action="expected_value",
            reviewed_by="user:user-1",
        )

    assert derived.revision == 2


def test_statistical_rule_does_not_compare_small_unrelated_item_groups(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    rows = [
        {"Mã hàng": "A", "Đơn giá": 100 + (index % 3)}
        for index in range(20)
    ] + [
        {"Mã hàng": "B", "Đơn giá": 100000 + index}
        for index in range(10)
    ]
    session = store.create_session(
        upload_id="grouped",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["Mã hàng", "Đơn giá"], rows=rows),
        raw_sha256="raw",
        ttl_seconds=3600,
    )

    result = detect_anomalies(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert not [issue for issue in result["issues"] if issue["rule_id"] == "numeric_robust_outlier"]
    evaluations = result["statistical_evaluations"]
    assert {tuple(item["group"]) for item in evaluations} == {("a",), ("b",)}
    by_group = {tuple(item["group"]): item for item in evaluations}
    assert by_group[("a",)]["status"] == "evaluated"
    assert by_group[("b",)]["status"] == "not_evaluated"
    assert by_group[("b",)]["reason"] == "minimum_sample_size_not_met"


def test_statistical_rule_reports_zero_mad_as_not_evaluated(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    rows = [{"Mã hàng": "A", "Đơn giá": 100} for _ in range(25)]
    session = store.create_session(
        upload_id="zero-mad",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["Mã hàng", "Đơn giá"], rows=rows),
        raw_sha256="raw",
        ttl_seconds=3600,
    )

    result = detect_anomalies(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert not [issue for issue in result["issues"] if issue["rule_id"] == "numeric_robust_outlier"]
    assert result["statistical_evaluations"] == [
        {
            "rule_id": "numeric_robust_outlier",
            "field": "Đơn giá",
            "group": ["a"],
            "sample_size": 25,
            "status": "not_evaluated",
            "reason": "zero_mad",
        }
    ]


def test_detection_ignores_client_supplied_readiness_issues(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)

    result = detect_anomalies(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        readiness_issues=[
            {
                "code": "client_forged_issue",
                "severity": "blocker",
                "message": "FORGED CLIENT ISSUE",
            }
        ],
    )

    assert all(issue["rule_id"] != "client_forged_issue" for issue in result["issues"])
