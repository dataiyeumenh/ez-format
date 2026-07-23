import base64
import hashlib
import hmac
import json
import time
from io import BytesIO
from pathlib import Path

import openpyxl
import pytest

from app import student_store as student_store_module
from app.misa_workflow import (
    analyze_upload,
    confirm_mapping,
    export_confirmed_profile,
    preview_mapping,
)
from app.student_context import verify_student_context
from app.student_store import (
    StudentUploadConflictError,
    assert_upload_owner,
    bind_upload_to_student,
    claim_student_analysis,
    cleanup_expired_student_uploads,
    find_student_upload_id,
)


def _encode_part(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _student_token(secret="student-secret", **overrides):
    payload = {
        "purpose": "student_file_session",
        "session_id": "session-1",
        "user_id": "user-1",
        "owner_scope": "user:user-1",
        "workspace_id": None,
        "snapshot_set_hash": None,
        "allowed_scopes": ["analyze", "explain", "attempt", "export"],
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
        "retention_expires_at": int(time.time()) + 24 * 60 * 60,
    }
    payload.update(overrides)
    header_part = _encode_part({"alg": "HS256", "typ": "JWT"})
    payload_part = _encode_part(payload)
    signed = f"{header_part}.{payload_part}".encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
    signature_part = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header_part}.{payload_part}.{signature_part}"


def _workbook_bytes():
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Mã hóa đơn", "Thời gian", "Mã hàng"])
    sheet.append(["HD001", "01/01/2026", "SP001"])
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_verify_student_context_accepts_node_compatible_hs256_claims(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")

    claims = verify_student_context(_student_token(), "analyze")

    assert claims.session_id == "session-1"
    assert claims.user_id == "user-1"
    assert claims.owner_scope == "user:user-1"
    assert claims.allowed_scopes == ("analyze", "explain", "attempt", "export")


@pytest.mark.parametrize(
    ("overrides", "required_scope", "message"),
    [
        ({"exp": int(time.time()) - 1}, "analyze", "hết hạn"),
        ({"purpose": "misa_conversion"}, "analyze", "mục đích"),
        ({"allowed_scopes": ["export"]}, "analyze", "thiếu quyền"),
        ({"session_id": ""}, "analyze", "session"),
        ({"user_id": ""}, "analyze", "user"),
        ({"owner_scope": "user:another-user"}, "analyze", "owner scope"),
    ],
)
def test_verify_student_context_rejects_invalid_claims(
    monkeypatch, overrides, required_scope, message
):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")

    with pytest.raises(ValueError, match=message):
        verify_student_context(_student_token(**overrides), required_scope)


def test_student_upload_binding_rejects_cross_owner_and_session(tmp_path, monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
    upload_dir = tmp_path / "upload-1"
    upload_dir.mkdir()
    (upload_dir / "input.xlsx").write_bytes(b"raw-workbook")
    claims = verify_student_context(_student_token(), "analyze")

    bind_upload_to_student("upload-1", claims, ttl_seconds=600)

    metadata = json.loads((upload_dir / "student.json").read_text(encoding="utf-8"))
    assert set(metadata) == {
        "session_id",
        "user_id",
        "owner_scope",
        "workspace_id",
        "expires_at",
    }
    assert_upload_owner("upload-1", claims)

    other_owner = verify_student_context(
        _student_token(
            session_id="session-2",
            user_id="user-2",
            owner_scope="user:user-2",
        ),
        "analyze",
    )
    with pytest.raises(ValueError, match="không thuộc"):
        assert_upload_owner("upload-1", other_owner)

    with pytest.raises(ValueError, match="Upload id không hợp lệ"):
        assert_upload_owner("..", claims)


def test_student_upload_survives_context_refresh_until_signed_retention_boundary(
    tmp_path, monkeypatch
):
    now = int(time.time())
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
    monkeypatch.setattr(student_store_module.time, "time", lambda: now)
    upload_dir = tmp_path / "upload-retained"
    upload_dir.mkdir()
    (upload_dir / "input.xlsx").write_bytes(b"raw-workbook")
    claims = verify_student_context(
        _student_token(exp=now + 60, retention_expires_at=now + 3600),
        "analyze",
    )

    bind_upload_to_student("upload-retained", claims, ttl_seconds=3600)

    metadata = json.loads((upload_dir / "student.json").read_text(encoding="utf-8"))
    assert metadata["expires_at"] == now + 3600
    assert metadata["expires_at"] > claims.exp

    refreshed_claims = verify_student_context(
        _student_token(exp=now + 120, retention_expires_at=now + 3600),
        "analyze",
    )
    monkeypatch.setattr(student_store_module.time, "time", lambda: now + 61)
    assert_upload_owner("upload-retained", refreshed_claims)


def test_cleanup_expired_student_uploads_deletes_only_expired_bound_directories(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
    claims = verify_student_context(_student_token(exp=int(time.time()) + 3600), "analyze")
    for upload_id in ("expired", "active"):
        upload_dir = tmp_path / upload_id
        upload_dir.mkdir()
        (upload_dir / "input.xlsx").write_bytes(b"raw-workbook")
        bind_upload_to_student(upload_id, claims, ttl_seconds=600)

    expired_metadata = json.loads(
        (tmp_path / "expired" / "student.json").read_text(encoding="utf-8")
    )
    expired_metadata["expires_at"] = 100
    (tmp_path / "expired" / "student.json").write_text(
        json.dumps(expired_metadata), encoding="utf-8"
    )

    deleted = cleanup_expired_student_uploads(now=200)

    assert deleted == ["expired"]
    assert not (tmp_path / "expired").exists()
    assert (tmp_path / "active").exists()


def test_find_student_upload_rejects_multiple_active_matches(tmp_path, monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
    claims = verify_student_context(_student_token(), "analyze")
    for upload_id in ("upload-a", "upload-b"):
        upload_dir = tmp_path / upload_id
        upload_dir.mkdir()
        bind_upload_to_student(upload_id, claims, ttl_seconds=600)

    with pytest.raises(StudentUploadConflictError, match="nhiều upload"):
        find_student_upload_id(claims)


def test_student_analysis_claim_is_hashed_atomic_and_released(tmp_path, monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
    claims = verify_student_context(
        _student_token(
            session_id="../session-1",
            user_id="owner-1",
            owner_scope="user:owner-1",
        ),
        "analyze",
    )

    with claim_student_analysis(claims):
        lock_files = list(tmp_path.glob(".student-analyze-*.lock"))
        assert len(lock_files) == 1
        assert claims.session_id not in lock_files[0].name
        assert claims.owner_scope not in lock_files[0].name
        lock_path = lock_files[0]
        with pytest.raises(StudentUploadConflictError, match="đang được phân tích"):
            with claim_student_analysis(claims):
                pass

    assert not lock_path.exists()


def test_reclaim_mutex_advisory_lock_blocks_a_second_holder(tmp_path):
    reclaim_path = tmp_path / ".student-analyze-race.reclaim"

    with student_store_module._claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        assert acquired is True
        with student_store_module._claim_analysis_reclaim_mutex(
            reclaim_path
        ) as second_acquired:
            assert second_acquired is False


def test_reclaim_mutex_advisory_lock_releases_after_holder_closes(tmp_path):
    reclaim_path = tmp_path / ".student-analyze-race.reclaim"

    with student_store_module._claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        assert acquired is True

    with student_store_module._claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        assert acquired is True


def test_reclaim_mutex_file_is_never_unlinked_or_recreated(tmp_path):
    reclaim_path = tmp_path / ".student-analyze-race.reclaim"

    with student_store_module._claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        assert acquired is True
        first_identity = reclaim_path.stat().st_ino

    with student_store_module._claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        assert acquired is True
        assert reclaim_path.stat().st_ino == first_identity


def test_student_upload_is_bound_before_workbook_write_failure_and_later_cleaned(
    tmp_path, monkeypatch
):
    upload_root = tmp_path / "uploads"
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setenv("STUDENT_UPLOAD_RETENTION_SECONDS", "1")
    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
    original_write_bytes = Path.write_bytes

    def fail_input_write(path, data):
        if path.name.startswith("input"):
            raise OSError("simulated workbook write failure")
        return original_write_bytes(path, data)

    monkeypatch.setattr(Path, "write_bytes", fail_input_write)

    with pytest.raises(OSError, match="simulated workbook write failure"):
        analyze_upload(
            filename="student.xlsx",
            content=_workbook_bytes(),
            requested_target_template_id="bsn_sales",
            student_context_token=_student_token(),
        )

    upload_dirs = [path for path in upload_root.iterdir() if path.is_dir()]
    assert len(upload_dirs) == 1
    metadata = json.loads(
        (upload_dirs[0] / "student.json").read_text(encoding="utf-8")
    )
    assert not (upload_dirs[0] / "input.xlsx").exists()

    deleted = cleanup_expired_student_uploads(now=metadata["expires_at"])

    assert deleted == [upload_dirs[0].name]
    assert not upload_dirs[0].exists()


def test_analyze_binds_student_owner_and_preview_rejects_cross_owner(
    tmp_path, monkeypatch
):
    upload_root = tmp_path / "uploads"
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.misa_workflow.find_mapping_profile", lambda *args, **kwargs: None)
    token = _student_token()

    analyzed = analyze_upload(
        filename="student.xlsx",
        content=_workbook_bytes(),
        requested_target_template_id="bsn_sales",
        student_context_token=token,
    )
    claims = verify_student_context(token, "analyze")
    assert_upload_owner(analyzed["upload_id"], claims)

    other_token = _student_token(
        session_id="session-2",
        user_id="user-2",
        owner_scope="user:user-2",
    )
    suggestion = analyzed["mapping_suggestion"]
    with pytest.raises(ValueError, match="không thuộc"):
        preview_mapping(
            upload_id=analyzed["upload_id"],
            target_template_id="bsn_sales",
            mapping=suggestion["mapping"],
            defaults=suggestion["defaults"],
            formulas=suggestion["formulas"],
            student_context_token=other_token,
        )


def test_analyze_rejects_combining_student_and_conversion_contexts(
    tmp_path, monkeypatch
):
    upload_root = tmp_path / "uploads"
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)

    with pytest.raises(ValueError, match="đồng thời"):
        analyze_upload(
            filename="student.xlsx",
            content=_workbook_bytes(),
            requested_target_template_id="bsn_sales",
            conversion_context_token="conversion-token",
            student_context_token=_student_token(),
        )


def test_student_mapping_operations_require_operation_specific_scopes(
    tmp_path, monkeypatch
):
    upload_root = tmp_path / "uploads"
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
    monkeypatch.setattr("app.misa_workflow.find_mapping_profile", lambda *args, **kwargs: None)
    phase_one = _student_token(allowed_scopes=["analyze", "explain"])
    analyzed = analyze_upload(
        filename="student.xlsx",
        content=_workbook_bytes(),
        requested_target_template_id="bsn_sales",
        student_context_token=phase_one,
    )
    suggestion = analyzed["mapping_suggestion"]

    preview_mapping(
        upload_id=analyzed["upload_id"],
        target_template_id="bsn_sales",
        mapping=suggestion["mapping"],
        defaults=suggestion["defaults"],
        formulas=suggestion["formulas"],
        student_context_token=phase_one,
    )

    with pytest.raises(ValueError, match="attempt"):
        confirm_mapping(
            upload_id=analyzed["upload_id"],
            target_template_id="bsn_sales",
            mapping=suggestion["mapping"],
            defaults=suggestion["defaults"],
            formulas=suggestion["formulas"],
            student_context_token=phase_one,
        )

    with pytest.raises(ValueError, match="export"):
        export_confirmed_profile(
            upload_id=analyzed["upload_id"],
            profile_id="profile-1",
            student_context_token=phase_one,
        )
