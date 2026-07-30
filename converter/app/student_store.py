from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Iterator

from app.conversion_types import BACKEND_ROOT
from app.student_context import StudentContextClaims


UPLOAD_ROOT = BACKEND_ROOT / ".artifacts" / "uploads"
STUDENT_METADATA_FILENAME = "student.json"
STUDENT_RETENTION_TYPE = "student"
STUDENT_OWNER_TYPES = {"user", "workspace"}
MAX_STUDENT_UPLOAD_TTL_SECONDS = 24 * 60 * 60
MAX_STUDENT_ANALYZE_TIMEOUT_SECONDS = 60 * 60


class StudentUploadConflictError(ValueError):
    pass


@contextmanager
def claim_student_analysis(claims: StudentContextClaims) -> Iterator[None]:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    identity = json.dumps(
        {
            "session_id": claims.session_id,
            "user_id": claims.user_id,
            "owner_scope": claims.owner_scope,
            "workspace_id": str(claims.workspace_id or ""),
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = sha256(identity.encode("utf-8")).hexdigest()
    lock_path = UPLOAD_ROOT / f".student-analyze-{digest}.lock"
    reclaim_path = lock_path.with_suffix(".reclaim")
    token = uuid.uuid4().hex
    timeout_seconds = student_analyze_timeout_seconds()
    try:
        _create_analysis_lock(lock_path, token)
    except FileExistsError as exc:
        if not _reclaim_stale_analysis_lock(lock_path, reclaim_path, token, timeout_seconds):
            raise StudentUploadConflictError(
                "Phiên học đang được phân tích"
            ) from exc

    stop_heartbeat = threading.Event()
    heartbeat = threading.Thread(
        target=_heartbeat_analysis_lock,
        args=(lock_path, reclaim_path, token, timeout_seconds, stop_heartbeat),
        daemon=True,
    )
    heartbeat.start()
    try:
        yield
    finally:
        stop_heartbeat.set()
        heartbeat.join(timeout=1)
        _remove_analysis_lock_if_owned(lock_path, token)


def student_analyze_timeout_seconds() -> int:
    raw_value = os.getenv("STUDENT_ANALYZE_TIMEOUT_SECONDS", "120")
    try:
        timeout_seconds = int(raw_value)
    except ValueError as exc:
        raise ValueError("STUDENT_ANALYZE_TIMEOUT_SECONDS không hợp lệ") from exc
    if not 0 < timeout_seconds <= MAX_STUDENT_ANALYZE_TIMEOUT_SECONDS:
        raise ValueError("Student analyze timeout phải từ 1 giây đến 1 giờ")
    return timeout_seconds


def _create_analysis_lock(lock_path: Path, token: str) -> None:
    descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        now = time.time()
        _write_lock_descriptor(
            descriptor,
            {"token": token, "created_at": now, "heartbeat_at": now},
        )
    finally:
        os.close(descriptor)


def _reclaim_stale_analysis_lock(
    lock_path: Path,
    reclaim_path: Path,
    token: str,
    timeout_seconds: int,
) -> bool:
    with _claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        if not acquired or not _analysis_lock_is_stale(lock_path, timeout_seconds):
            return False
        lock_path.unlink(missing_ok=True)
        try:
            _create_analysis_lock(lock_path, token)
        except FileExistsError:
            return False
        return True


def _analysis_lock_is_stale(lock_path: Path, timeout_seconds: int) -> bool:
    try:
        stat = lock_path.stat()
    except FileNotFoundError:
        return True
    timestamp = stat.st_mtime
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
        timestamp = float(payload.get("heartbeat_at") or payload.get("created_at") or timestamp)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
        pass
    return time.time() - timestamp > timeout_seconds


def _heartbeat_analysis_lock(
    lock_path: Path,
    reclaim_path: Path,
    token: str,
    timeout_seconds: int,
    stop_event: threading.Event,
) -> None:
    interval = max(0.1, min(5.0, timeout_seconds / 3))
    while not stop_event.wait(interval):
        if not _refresh_analysis_lock(lock_path, reclaim_path, token) and not lock_path.exists():
            return


def _refresh_analysis_lock(lock_path: Path, reclaim_path: Path, token: str) -> bool:
    with _claim_analysis_reclaim_mutex(reclaim_path) as acquired:
        if not acquired:
            return False
        try:
            descriptor = os.open(lock_path, os.O_RDWR)
        except FileNotFoundError:
            return False
        try:
            payload = _read_lock_descriptor(descriptor)
            if payload.get("token") != token:
                return False
            payload["heartbeat_at"] = time.time()
            _write_lock_descriptor(descriptor, payload)
            return True
        finally:
            os.close(descriptor)


@contextmanager
def _claim_analysis_reclaim_mutex(reclaim_path: Path) -> Iterator[bool]:
    """Hold the persistent reclaimer mutex until its process releases it."""
    descriptor = os.open(reclaim_path, os.O_CREAT | os.O_RDWR, 0o600)
    locked = False
    try:
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"0")
        locked = _try_lock_analysis_reclaim_mutex(descriptor)
        yield locked
    finally:
        if locked:
            _unlock_analysis_reclaim_mutex(descriptor)
        os.close(descriptor)


def _try_lock_analysis_reclaim_mutex(descriptor: int) -> bool:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            if exc.winerror in (32, 33) or exc.errno in (13, 11):
                return False
            raise
        return True

    import errno
    import fcntl

    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EAGAIN):
            return False
        raise
    return True


def _unlock_analysis_reclaim_mutex(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_UN)


def _read_lock_descriptor(descriptor: int) -> dict:
    os.lseek(descriptor, 0, os.SEEK_SET)
    raw = os.read(descriptor, 4096)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_lock_descriptor(descriptor: int, payload: dict) -> None:
    raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.ftruncate(descriptor, 0)
    os.write(descriptor, raw)
    os.fsync(descriptor)


def _remove_analysis_lock_if_owned(lock_path: Path, token: str) -> None:
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if isinstance(payload, dict) and payload.get("token") == token:
        lock_path.unlink(missing_ok=True)


def student_upload_retention_seconds() -> int:
    raw_value = os.getenv(
        "STUDENT_UPLOAD_RETENTION_SECONDS",
        str(MAX_STUDENT_UPLOAD_TTL_SECONDS),
    )
    try:
        ttl_seconds = int(raw_value)
    except ValueError as exc:
        raise ValueError("STUDENT_UPLOAD_RETENTION_SECONDS không hợp lệ") from exc
    if not 0 < ttl_seconds <= MAX_STUDENT_UPLOAD_TTL_SECONDS:
        raise ValueError("Student upload retention phải từ 1 giây đến 24 giờ")
    return ttl_seconds


def bind_upload_to_student(
    upload_id: str,
    claims: StudentContextClaims,
    ttl_seconds: int,
) -> None:
    normalized_upload_id = _normalized_upload_id(upload_id)
    if not 0 < int(ttl_seconds) <= MAX_STUDENT_UPLOAD_TTL_SECONDS:
        raise ValueError("Student upload TTL phải từ 1 giây đến 24 giờ")
    now = int(time.time())
    expires_at = min(claims.retention_expires_at, now + int(ttl_seconds))
    if expires_at <= now:
        raise ValueError("Student upload context đã hết hạn")

    upload_dir = UPLOAD_ROOT / normalized_upload_id
    if not upload_dir.is_dir():
        raise KeyError(f"Upload not found: {normalized_upload_id}")
    owner_type = str(claims.owner_scope or "").partition(":")[0]
    if owner_type not in STUDENT_OWNER_TYPES:
        raise ValueError("Student upload owner type không hợp lệ")
    metadata = {
        "retention_type": STUDENT_RETENTION_TYPE,
        "owner_type": owner_type,
        "session_id": claims.session_id,
        "user_id": claims.user_id,
        "owner_scope": claims.owner_scope,
        "workspace_id": claims.workspace_id,
        "expires_at": expires_at,
    }
    metadata_path = upload_dir / STUDENT_METADATA_FILENAME
    temporary_path = metadata_path.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_path.replace(metadata_path)


def assert_upload_owner(upload_id: str, claims: StudentContextClaims) -> None:
    metadata = _read_student_metadata(upload_id)
    if int(metadata.get("expires_at") or 0) <= int(time.time()):
        raise ValueError("Student upload đã hết hạn")
    expected = (
        str(metadata.get("session_id") or ""),
        str(metadata.get("user_id") or ""),
        str(metadata.get("owner_scope") or ""),
        str(metadata.get("workspace_id") or ""),
    )
    actual = (
        claims.session_id,
        claims.user_id,
        claims.owner_scope,
        str(claims.workspace_id or ""),
    )
    if not all(expected[:3]):
        raise ValueError("Student upload metadata không hợp lệ")
    if expected != actual:
        raise ValueError("Student upload không thuộc owner hoặc session này")


def student_upload_is_bound(upload_id: str) -> bool:
    return (_student_metadata_path(upload_id)).is_file()


def find_student_upload_id(claims: StudentContextClaims) -> str:
    matches, expired_match = _matching_student_upload_ids(claims)
    if len(matches) > 1:
        raise StudentUploadConflictError("Phiên học có nhiều upload đang hoạt động")
    if matches:
        return matches[0]
    if expired_match:
        raise ValueError("Student upload đã hết hạn")
    raise KeyError(claims.session_id)


def assert_no_student_upload_for_session(claims: StudentContextClaims) -> None:
    matches, _ = _matching_student_upload_ids(claims)
    if matches:
        raise StudentUploadConflictError("Phiên học đã có upload đang hoạt động")


def _matching_student_upload_ids(
    claims: StudentContextClaims,
) -> tuple[list[str], bool]:
    if not UPLOAD_ROOT.is_dir():
        return [], False
    matches: list[str] = []
    expired_match = False
    for upload_dir in sorted(UPLOAD_ROOT.iterdir(), key=lambda path: path.name):
        if not upload_dir.is_dir():
            continue
        try:
            metadata = _read_student_metadata(upload_dir.name)
        except ValueError:
            continue
        if str(metadata.get("session_id") or "") != claims.session_id:
            continue
        expected = (
            str(metadata.get("user_id") or ""),
            str(metadata.get("owner_scope") or ""),
            str(metadata.get("workspace_id") or ""),
        )
        actual = (
            claims.user_id,
            claims.owner_scope,
            str(claims.workspace_id or ""),
        )
        if expected != actual:
            continue
        if int(metadata.get("expires_at") or 0) <= int(time.time()):
            expired_match = True
            continue
        matches.append(upload_dir.name)
    return matches, expired_match


def cleanup_expired_student_uploads(now=None) -> list[str]:
    current_time = _timestamp(now)
    if not UPLOAD_ROOT.is_dir():
        return []
    deleted: list[str] = []
    for upload_dir in sorted(UPLOAD_ROOT.iterdir(), key=lambda path: path.name):
        if not upload_dir.is_dir():
            continue
        metadata_path = upload_dir / STUDENT_METADATA_FILENAME
        if not metadata_path.is_file():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            expires_at = int(metadata.get("expires_at") or 0)
        except (OSError, ValueError, json.JSONDecodeError, AttributeError):
            expires_at = 0
        if expires_at > current_time:
            continue
        shutil.rmtree(upload_dir, ignore_errors=True)
        if not upload_dir.exists():
            deleted.append(upload_dir.name)
    return deleted


def _read_student_metadata(upload_id: str) -> dict:
    path = _student_metadata_path(upload_id)
    if not path.is_file():
        raise ValueError("Upload chưa được bind với student context")
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Student upload metadata không hợp lệ") from exc
    if not isinstance(metadata, dict):
        raise ValueError("Student upload metadata không hợp lệ")
    return metadata


def _student_metadata_path(upload_id: str) -> Path:
    return UPLOAD_ROOT / _normalized_upload_id(upload_id) / STUDENT_METADATA_FILENAME


def _normalized_upload_id(upload_id: str) -> str:
    normalized = str(upload_id or "").strip()
    if (
        not normalized
        or normalized in {".", ".."}
        or "/" in normalized
        or "\\" in normalized
        or Path(normalized).name != normalized
    ):
        raise ValueError("Upload id không hợp lệ")
    return normalized


def _timestamp(value) -> int:
    if value is None:
        return int(time.time())
    if isinstance(value, datetime):
        return int(value.timestamp())
    return int(value)
