from __future__ import annotations

import hashlib
import heapq
import hmac
import json
import os
import shutil
import tempfile
import threading
import uuid
from contextlib import ExitStack, contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator

from app.conversion_types import BACKEND_ROOT
from app.excel_io import InputTable, read_input_table
from app.internal_auth import unauthenticated_local_operations_enabled as _local_mode_enabled
from app.master_data_client import ConversionContextError, verify_conversion_context_token
from app.operation_models import DerivedRevision, NormalizedSession
from app.operation_store_client import NodeOperationStoreClient, OperationStoreClientError


STUDENT_METADATA_STATE_CONTRACT = "student_metadata_v1"
DEFAULT_OPERATION_SESSION_CLEANUP_BATCH_SIZE = 100
DEFAULT_OPERATION_SESSION_CREATION_GRACE_SECONDS = 300
MIN_OPERATION_FENCE_RETENTION_SECONDS = 24 * 60 * 60
_OPERATION_SESSION_DIRECTORY_LOCK = threading.RLock()
_ACTIVE_OPERATION_SESSION_CREATIONS: set[tuple[str, str]] = set()
_OPERATION_CLEANUP_CURSOR_LOCK = threading.Lock()
_OPERATION_CLEANUP_CURSORS: dict[tuple[str, str], str] = {}


class OperationStoreError(ValueError):
    pass


class OperationStoreConflictError(OperationStoreError):
    pass


class OperationStoreExpiredError(OperationStoreError):
    pass


def unauthenticated_local_operations_enabled() -> bool:
    return _local_mode_enabled()


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes"}


def local_operation_store_enabled() -> bool:
    return (
        os.getenv("OPERATION_STORE_PROVIDER", "").strip().lower() == "local"
        and os.getenv("NODE_ENV", "").strip().lower() in {"development", "test"}
        and _env_enabled("OPERATION_STORE_ALLOW_LOCAL")
        and bool(os.getenv("CONVERTER_SERVICE_TOKEN", "").strip())
    )


def node_operation_store_enabled() -> bool:
    return os.getenv("OPERATION_STORE_PROVIDER", "").strip().lower() == "node"


def assert_student_metadata_v1_rollout_configured() -> str:
    mode = os.getenv("STUDENT_METADATA_V1_ROLLOUT_MODE", "").strip().lower()
    production_student_node = (
        os.getenv("NODE_ENV", "").strip().lower() == "production"
        and node_operation_store_enabled()
        and _env_enabled("STUDENT_ASSISTANT_ENABLED")
    )
    if not production_student_node:
        return mode or "not_required"
    if mode not in {"drain", "complete"}:
        raise OperationStoreError(
            "STUDENT_METADATA_V1_ROLLOUT_MODE must be drain or complete in production"
        )
    if not _env_enabled("STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED"):
        raise OperationStoreError(
            "STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED=true is required before production Student startup"
        )
    return mode


def assert_student_metadata_v1_new_sessions_allowed() -> None:
    if (
        node_operation_store_enabled()
        and os.getenv("STUDENT_METADATA_V1_ROLLOUT_MODE", "").strip().lower()
        == "drain"
    ):
        raise OperationStoreError(
            "Legacy Student drain is active; new Student analyses are disabled"
        )


def assert_operation_store_configured(*, remote_client: Any | None = None) -> str:
    if remote_client is not None:
        return "node"

    provider = os.getenv("OPERATION_STORE_PROVIDER", "").strip().lower()
    if provider == "node":
        return provider
    if provider == "local":
        environment = os.getenv("NODE_ENV", "").strip().lower()
        if environment not in {"development", "test"}:
            raise OperationStoreError(
                "Local operation store chỉ được phép trong development/test"
            )
        if not _env_enabled("OPERATION_STORE_ALLOW_LOCAL"):
            raise OperationStoreError(
                "Local operation store requires OPERATION_STORE_ALLOW_LOCAL=true"
            )
        if not os.getenv("CONVERTER_SERVICE_TOKEN", "").strip():
            raise OperationStoreError(
                "Authenticated local operation store requires a service token"
            )
        return provider
    if provider:
        raise OperationStoreError("OPERATION_STORE_PROVIDER không hợp lệ")
    raise OperationStoreError(
        "OPERATION_STORE_PROVIDER phải được cấu hình rõ là node hoặc local"
    )


def operation_context_required() -> bool:
    """Return whether conversion state must be backed by a signed Node session."""
    return assert_operation_store_configured() == "node"


def cleanup_expired_operation_sessions(
    root: Path | None = None,
    *,
    now: datetime | None = None,
    batch_size: int | None = None,
) -> list[str]:
    configured = os.getenv("OPERATION_SESSION_DIR", "").strip()
    session_root = root or (
        Path(configured)
        if configured
        else BACKEND_ROOT / ".artifacts" / "operation-sessions"
    )
    configured_limit = batch_size
    if configured_limit is None:
        configured_limit = os.getenv(
            "OPERATION_SESSION_CLEANUP_BATCH_SIZE",
            str(DEFAULT_OPERATION_SESSION_CLEANUP_BATCH_SIZE),
        )
    try:
        limit = min(max(int(configured_limit), 1), 1000)
    except (TypeError, ValueError):
        limit = DEFAULT_OPERATION_SESSION_CLEANUP_BATCH_SIZE
    current_time = now or datetime.now(timezone.utc)
    deleted: list[str] = []
    scan_limit = min(limit * 8, 8000)
    lifecycle_root = session_root.parent / f".{session_root.name}-lifecycle"
    if session_root.is_dir() or lifecycle_root.is_dir():
        lifecycle_root.mkdir(parents=True, exist_ok=True)
        _assert_operation_fence_key_coverage(lifecycle_root)

    session_cursor_key = (str(session_root.resolve()), "sessions")
    directories = _bounded_cleanup_paths(
        lambda: session_root.iterdir(),
        cursor_key=session_cursor_key,
        scan_limit=scan_limit,
        predicate=lambda path: path.is_dir() or path.is_symlink(),
    ) if session_root.is_dir() else []
    inspected_sessions = 0
    last_session_name = ""
    for directory in directories:
        inspected_sessions += 1
        last_session_name = directory.name
        with _OPERATION_SESSION_DIRECTORY_LOCK:
            if _creation_registry_key(session_root, directory) in (
                _ACTIVE_OPERATION_SESSION_CREATIONS
            ):
                continue
        expires_at = _local_session_expiry(directory)
        if expires_at is not None and expires_at > current_time:
            continue
        try:
            removed = _coordinated_remove_expired_directory(
                session_root,
                directory,
            )
        except (OSError, OperationStoreError):
            continue
        if removed:
            deleted.append(directory.name)
            if len(deleted) >= limit:
                break
    _advance_cleanup_cursor(
        session_cursor_key,
        last_session_name,
        scanned=inspected_sessions,
        available=len(directories),
        scan_limit=scan_limit,
    )

    if lifecycle_root.is_dir():
        fence_cursor_key = (str(lifecycle_root.resolve()), "fences")
        state_paths = _bounded_cleanup_paths(
            lambda: lifecycle_root.glob("*.json"),
            cursor_key=fence_cursor_key,
            scan_limit=scan_limit,
            predicate=lambda path: not path.name.startswith(".key-canary-"),
        )
        inspected_fences = 0
        deleted_fences = 0
        last_fence_name = ""
        for state_path in state_paths:
            inspected_fences += 1
            last_fence_name = state_path.name
            try:
                migrated_path = _migrate_legacy_lifecycle_path(state_path)
                payload = _read_lifecycle_payload(migrated_path, expected_schema=2)
                if not _purged_fence_is_expired(payload, current_time):
                    continue
                if _remove_expired_purged_fence(migrated_path, current_time):
                    deleted_fences += 1
                    if deleted_fences >= limit:
                        break
            except (OSError, OperationStoreError):
                continue
        _advance_cleanup_cursor(
            fence_cursor_key,
            last_fence_name,
            scanned=inspected_fences,
            available=len(state_paths),
            scan_limit=scan_limit,
        )
    return deleted


def _bounded_cleanup_paths(
    paths: Callable[[], Iterator[Path]],
    *,
    cursor_key: tuple[str, str],
    scan_limit: int,
    predicate: Callable[[Path], bool],
) -> list[Path]:
    with _OPERATION_CLEANUP_CURSOR_LOCK:
        after_name = _OPERATION_CLEANUP_CURSORS.get(cursor_key, "")

    def select(after: str) -> list[Path]:
        return heapq.nsmallest(
            scan_limit,
            (
                path
                for path in paths()
                if path.name > after and predicate(path)
            ),
            key=lambda path: path.name,
        )

    selected = select(after_name)
    return selected if selected or not after_name else select("")


def _advance_cleanup_cursor(
    cursor_key: tuple[str, str],
    last_name: str,
    *,
    scanned: int,
    available: int,
    scan_limit: int,
) -> None:
    with _OPERATION_CLEANUP_CURSOR_LOCK:
        if last_name and (scanned < available or available == scan_limit):
            if cursor_key not in _OPERATION_CLEANUP_CURSORS and len(
                _OPERATION_CLEANUP_CURSORS
            ) >= 128:
                _OPERATION_CLEANUP_CURSORS.pop(next(iter(_OPERATION_CLEANUP_CURSORS)))
            _OPERATION_CLEANUP_CURSORS[cursor_key] = last_name
        else:
            _OPERATION_CLEANUP_CURSORS.pop(cursor_key, None)



class OperationStore:
    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()
    _lease_depths = threading.local()

    def __init__(
        self,
        root: Path | None = None,
        *,
        remote_client: Any | None = None,
        conversion_context_token: str | None = None,
        conversion_run_id: str | None = None,
    ) -> None:
        provider = assert_operation_store_configured(remote_client=remote_client)
        if provider == "node" and remote_client is None and not str(
            conversion_context_token or ""
        ).strip():
            raise OperationStoreError(
                "Production operation session requires a signed conversion context"
            )

        configured = os.getenv("OPERATION_SESSION_DIR", "").strip()
        self.root = root or (
            Path(configured)
            if configured
            else BACKEND_ROOT / ".artifacts" / "operation-sessions"
        )
        self.root.mkdir(parents=True, exist_ok=True)
        self._lifecycle_root = self.root.parent / f".{self.root.name}-lifecycle"
        self._lifecycle_root.mkdir(parents=True, exist_ok=True)
        _assert_operation_fence_key_coverage(self._lifecycle_root)
        self._remote_client = remote_client
        self._remote_run_id = str(conversion_run_id or "").strip()
        self._remote_payloads: dict[str, dict[str, Any]] = {}
        self._remote_storage_revisions: dict[str, int] = {}
        self._remote_state_sha256s: dict[str, str] = {}
        self._state_contracts: dict[str, str] = {}
        if (
            conversion_context_token
            and remote_client is None
            and provider == "node"
        ):
            try:
                claims = verify_conversion_context_token(conversion_context_token)
            except ConversionContextError as exc:
                raise OperationStoreError(
                    "Signed conversion context không hợp lệ"
                ) from exc
            if not str(claims.get("operation_session_id") or "").strip():
                raise OperationStoreError(
                    "Signed conversion context thiếu operation session"
                )
            try:
                self._remote_client = NodeOperationStoreClient(conversion_context_token)
            except (ConversionContextError, OperationStoreClientError) as exc:
                raise OperationStoreError(
                    "Không khởi tạo được remote operation session"
                ) from exc
            self._remote_run_id = str(claims.get("conversion_run_id") or "").strip()

    def create_session(
        self,
        *,
        session_id: str | None = None,
        upload_id: str,
        owner_scope: str,
        user_id: str | None,
        workspace_id: str | None,
        target_template_id: str,
        target_template_version: str,
        source_signature: dict[str, Any],
        table: InputTable,
        raw_sha256: str,
        conversion_run_id: str | None = None,
        ttl_seconds: int | None = None,
        initial_context: dict[str, Any] | None = None,
        state_contract: str | None = None,
    ) -> NormalizedSession:
        _validate_owner_binding(owner_scope, user_id, workspace_id)
        if state_contract not in {None, STUDENT_METADATA_STATE_CONTRACT}:
            raise OperationStoreError("Operation state contract không hợp lệ")
        expected_remote_session_id = str(
            getattr(self._remote_client, "session_id", "") or ""
        ).strip()
        supplied_session_id = str(session_id or "").strip()
        if supplied_session_id:
            if (
                self._remote_client is None
                or not expected_remote_session_id
                or supplied_session_id != expected_remote_session_id
            ):
                raise OperationStoreError("Preallocated session binding không hợp lệ")
            session_id = supplied_session_id
        else:
            if self._remote_client is not None and expected_remote_session_id:
                raise OperationStoreError("Preallocated session binding là bắt buộc")
            session_id = str(uuid.uuid4())
        self._directory(session_id)
        normalized_run_id = str(conversion_run_id or "").strip()
        if self._remote_client is not None:
            expected_run_id = str(
                getattr(self._remote_client, "run_id", self._remote_run_id) or ""
            ).strip()
            if not normalized_run_id or normalized_run_id != expected_run_id:
                raise OperationStoreError("Conversion run binding không hợp lệ")
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + timedelta(seconds=ttl_seconds or _ttl_seconds())
        table_payload = {
            "headers": list(table.headers),
            "rows": [
                {"row_id": f"r{index}", "values": _json_safe(row)}
                for index, row in enumerate(table.rows, start=1)
            ],
            "sheet_name": table.sheet_name,
            "header_row_index": table.header_row_index,
        }
        base_context = dict(_json_safe(initial_context or {}))
        base_context["target_template_id"] = target_template_id
        if normalized_run_id:
            base_context["conversion_run_id"] = normalized_run_id
        state_hash = _state_hash(table_payload, {}, base_context)
        base_revision = DerivedRevision(
            revision=1,
            parent_revision=None,
            state_hash=state_hash,
            overlays={},
            context=base_context,
            created_by=owner_scope,
            created_at=created_at,
        )
        session = NormalizedSession(
            session_id=session_id,
            upload_id=upload_id,
            user_id=user_id,
            workspace_id=workspace_id,
            owner_scope=owner_scope,
            target_template_id=target_template_id,
            target_template_version=target_template_version,
            source_signature=_json_safe(source_signature),
            primary_table_id=str(uuid.uuid4()),
            active_revision=1,
            state_hash=state_hash,
            raw_sha256=raw_sha256,
            created_at=created_at,
            expires_at=expires_at,
            revisions=[base_revision],
        )
        cls = type(self)
        with cls._locks_guard:
            creation_lock = cls._locks.setdefault(session_id, threading.RLock())
        write_lease = self._write_lease(session_id, initialize=True)
        write_lease.__enter__()
        creation_lock.acquire()
        if state_contract:
            self._state_contracts[session_id] = state_contract
        persist_local = self._remote_client is None
        directory = self._directory(session_id)
        staging_directory: Path | None = None
        creation_key: tuple[str, str] | None = None
        remote_saved = False
        remote_attempted = False
        try:
            if persist_local:
                staging_directory = self.root / (
                    f".creating-{session_id}-{uuid.uuid4().hex}"
                )
                creation_key = _creation_registry_key(self.root, staging_directory)
                marker_payload = {
                    "kind": "operation_session_creation_v1",
                    "session_id": session_id,
                    "owner_type": (
                        "student"
                        if state_contract == STUDENT_METADATA_STATE_CONTRACT
                        else "operation"
                    ),
                    "state_contract": state_contract or "operation_state_v1",
                    "retention_expires_at": expires_at.isoformat(),
                    "expires_at": (
                        created_at + timedelta(seconds=_creation_grace_seconds())
                    ).isoformat(),
                }
                with _OPERATION_SESSION_DIRECTORY_LOCK:
                    if directory.exists() or directory.is_symlink():
                        raise OperationStoreConflictError(
                            "Operation session đã tồn tại"
                        )
                    staging_directory.mkdir(parents=False, exist_ok=False)
                    _ACTIVE_OPERATION_SESSION_CREATIONS.add(creation_key)
                    self._atomic_write(
                        staging_directory / ".creating.json",
                        marker_payload,
                    )
                self._atomic_write(staging_directory / "table.json", table_payload)

            if self._remote_client is not None:
                remote_attempted = True
                self._save_remote_state(session, table_payload)
                remote_saved = True

            if persist_local:
                assert staging_directory is not None
                self._atomic_write(
                    staging_directory / "session.json",
                    session.model_dump(mode="json"),
                )
                with _OPERATION_SESSION_DIRECTORY_LOCK:
                    if directory.exists() or directory.is_symlink():
                        raise OperationStoreConflictError(
                            "Operation session đã tồn tại"
                        )
                    (staging_directory / ".creating.json").unlink(missing_ok=True)
                    staging_directory.replace(directory)
                    if creation_key is not None:
                        _ACTIVE_OPERATION_SESSION_CREATIONS.discard(creation_key)
            return session
        except Exception:
            rollback_complete = True
            if self._remote_client is not None and (remote_attempted or remote_saved):
                rollback_complete = self._rollback_remote_creation(session)
            with _OPERATION_SESSION_DIRECTORY_LOCK:
                if creation_key is not None:
                    _ACTIVE_OPERATION_SESSION_CREATIONS.discard(creation_key)
                if staging_directory is not None and (
                    staging_directory.exists() or staging_directory.is_symlink()
                ):
                    _remove_operation_session_directory(self.root, staging_directory)
            self._remote_payloads.pop(session_id, None)
            self._remote_storage_revisions.pop(session_id, None)
            self._remote_state_sha256s.pop(session_id, None)
            self._state_contracts.pop(session_id, None)
            if staging_directory is not None:
                self._write_lifecycle_state(
                    session_id,
                    "purged" if rollback_complete else "purging",
                )
            raise
        finally:
            if creation_key is not None:
                with _OPERATION_SESSION_DIRECTORY_LOCK:
                    _ACTIVE_OPERATION_SESSION_CREATIONS.discard(creation_key)
            creation_lock.release()
            write_lease.__exit__(None, None, None)

    def load_session(self, session_id: str) -> NormalizedSession:
        with self._write_lease(session_id):
            return self._load_session_with_active_fence(session_id)

    def _load_session_with_active_fence(self, session_id: str) -> NormalizedSession:
        if self._remote_client is not None:
            try:
                session, _ = self._load_remote_state(session_id)
                return session
            except OperationStoreExpiredError:
                self._write_lifecycle_state(session_id, "purging")
                self._purge_local_state(session_id)
                raise
            except OperationStoreClientError as exc:
                if self._remote_error_requires_purge(exc):
                    self._write_lifecycle_state(session_id, "purging")
                    self._purge_local_state(session_id)
                self._raise_remote_error(exc)
        return self._load_local_session(session_id)

    def _load_local_session(self, session_id: str) -> NormalizedSession:
        path = self._directory(session_id) / "session.json"
        if not path.exists():
            raise OperationStoreError("Phiên chuyển đổi không tồn tại")
        try:
            session = NormalizedSession.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise OperationStoreError("Dữ liệu phiên chuyển đổi không hợp lệ") from exc
        if session.expires_at <= datetime.now(timezone.utc):
            self._write_lifecycle_state(session_id, "purging")
            self._purge_local_state(session_id)
            self._write_lifecycle_state(session_id, "purged")
            raise OperationStoreExpiredError("Phiên chuyển đổi đã hết hạn")
        return session

    def materialize_table(
        self,
        session_id: str,
        *,
        revision: int | None = None,
    ) -> InputTable:
        session = self.load_session(session_id)
        target = self._revision(session, revision or session.active_revision)
        table_payload = self._read_table(session_id)
        rows: list[dict[str, Any]] = []
        for item in table_payload["rows"]:
            values = dict(item["values"])
            values.update(target.overlays.get(str(item["row_id"]), {}))
            rows.append(values)
        return InputTable(
            headers=list(table_payload["headers"]),
            rows=rows,
            sheet_name=table_payload.get("sheet_name"),
            header_row_index=int(table_payload.get("header_row_index") or 0),
        )

    def materialize_rows_with_ids(
        self,
        session_id: str,
        *,
        revision: int | None = None,
    ) -> list[dict[str, Any]]:
        session = self.load_session(session_id)
        target = self._revision(session, revision or session.active_revision)
        output: list[dict[str, Any]] = []
        table_payload = self._read_table(session_id)
        raw_sheet = str(table_payload.get("sheet_name") or "")
        header_row_index = int(table_payload.get("header_row_index") or 0)
        for index, item in enumerate(table_payload["rows"]):
            values = dict(item["values"])
            values.update(target.overlays.get(str(item["row_id"]), {}))
            output.append(
                {
                    "row_id": str(item["row_id"]),
                    "values": values,
                    "source_origin": {
                        "raw_sheet": raw_sheet,
                        "raw_rows": [header_row_index + index + 2],
                    },
                }
            )
        return output

    def create_revision(
        self,
        session_id: str,
        *,
        expected_revision: int,
        expected_state_hash: str,
        changes: dict[str, dict[str, Any]],
        context_changes: dict[str, Any] | None = None,
        created_by: str,
        patch_set_id: str | None = None,
        activate: bool = False,
        validate: Callable[[InputTable, DerivedRevision], Any] | None = None,
    ) -> DerivedRevision:
        with self._lock(session_id):
            session = self.load_session(session_id)
            self._assert_current(session, expected_revision, expected_state_hash)
            base = self._revision(session, expected_revision)
            valid_row_ids = {
                str(item["row_id"]) for item in self._read_table(session_id)["rows"]
            }
            if any(row_id not in valid_row_ids for row_id in changes):
                raise OperationStoreError("Patch tham chiếu dòng không tồn tại")
            overlays = {
                row_id: dict(values) for row_id, values in base.overlays.items()
            }
            for row_id, fields in changes.items():
                overlays.setdefault(row_id, {}).update(_json_safe(fields))
            context = dict(base.context)
            context.update(_json_safe(context_changes or {}))
            table_payload = self._read_table(session_id)
            revision = DerivedRevision(
                revision=max(item.revision for item in session.revisions) + 1,
                parent_revision=base.revision,
                patch_set_id=patch_set_id,
                state_hash=_state_hash(table_payload, overlays, context),
                overlays=overlays,
                context=context,
                created_by=created_by,
                created_at=datetime.now(timezone.utc),
            )
            if validate is not None:
                validate(
                    self._materialize_payload(table_payload, revision),
                    revision,
                )
            session.revisions.append(revision)
            if activate:
                session.active_revision = revision.revision
                session.state_hash = revision.state_hash
            session.audit_events.append(
                {
                    "event": "revision_created",
                    "revision": revision.revision,
                    "patch_set_id": patch_set_id,
                    "activated": activate,
                }
            )
            self._save_session(session)
            return revision

    def activate_revision(
        self,
        session_id: str,
        *,
        revision: int,
        expected_revision: int,
        expected_state_hash: str,
        activated_by: str,
        activation_reason: str | None = None,
    ) -> NormalizedSession:
        with self._lock(session_id):
            session = self.load_session(session_id)
            self._assert_current(session, expected_revision, expected_state_hash)
            target = self._revision(session, revision)
            session.active_revision = target.revision
            session.state_hash = target.state_hash
            session.audit_events.append(
                {
                    "event": "revision_activated",
                    "revision": target.revision,
                    "activated_by": activated_by,
                    "reason": activation_reason,
                }
            )
            self._save_session(session)
            return session

    def list_revisions(self, session_id: str) -> list[DerivedRevision]:
        return list(self.load_session(session_id).revisions)

    def active_context(self, session_id: str) -> dict[str, Any]:
        session = self.load_session(session_id)
        return dict(self._revision(session, session.active_revision).context)

    def context_for_revision(self, session_id: str, revision: int) -> dict[str, Any]:
        session = self.load_session(session_id)
        return dict(self._revision(session, revision).context)

    def assert_owner(self, session_id: str, owner_scope: str) -> NormalizedSession:
        session = self.load_session(session_id)
        if session.owner_scope != owner_scope:
            raise OperationStoreError("Không tìm thấy phiên chuyển đổi")
        return session

    def assert_context_binding(
        self,
        session_id: str,
        claims: dict[str, Any],
        *,
        required_scope: str,
    ) -> NormalizedSession:
        if str(claims.get("operation_session_id") or "") != session_id:
            raise OperationStoreError("Không tìm thấy phiên chuyển đổi")
        scopes = claims.get("scopes")
        if not isinstance(scopes, list) or required_scope not in scopes:
            raise OperationStoreError("Conversion context không đủ phạm vi")

        session = self.load_session(session_id)
        expected = {
            "owner_scope": session.owner_scope,
            "user_id": str(session.user_id or ""),
            "workspace_id": str(session.workspace_id or ""),
            "upload_id": session.upload_id,
            "target_template_id": session.target_template_id,
            "conversion_run_id": str(
                session.revisions[0].context.get("conversion_run_id") or ""
            ),
        }
        if any(str(claims.get(key) or "") != value for key, value in expected.items()):
            raise OperationStoreError("Không tìm thấy phiên chuyển đổi")
        return session

    def assert_current(
        self,
        session_id: str,
        *,
        expected_revision: int,
        expected_state_hash: str,
    ) -> NormalizedSession:
        session = self.load_session(session_id)
        self._assert_current(session, expected_revision, expected_state_hash)
        return session

    def put_artifact(
        self,
        session_id: str,
        *,
        kind: str,
        revision: int,
        content: bytes,
        content_type: str,
    ) -> dict[str, Any] | None:
        with self._write_lease(session_id):
            session = self.load_session(session_id)
            if self._remote_client is None:
                return None
            run_id = self._remote_run_id or self._run_id_from_session(session)
            try:
                return self._remote_client.put_artifact(
                    session_id=session_id,
                    run_id=run_id,
                    kind=kind,
                    revision=revision,
                    content=content,
                    content_type=content_type,
                    expires_at=session.expires_at,
                )
            except OperationStoreClientError as exc:
                self._raise_remote_error(exc)
            except Exception as exc:
                raise OperationStoreError("Không lưu được artifact vào Node") from exc

    def get_artifact(
        self,
        session_id: str,
        *,
        kind: str,
        revision: int | None = None,
    ) -> bytes | None:
        session = self.load_session(session_id)
        if self._remote_client is None:
            return None
        run_id = self._remote_run_id or self._run_id_from_session(session)
        try:
            return self._remote_client.get_artifact(
                session_id=session_id,
                run_id=run_id,
                kind=kind,
                revision=revision,
            )
        except OperationStoreClientError as exc:
            self._raise_remote_error(exc)
        except Exception as exc:
            raise OperationStoreError("Không tải được artifact từ Node") from exc

    def _read_table(self, session_id: str) -> dict[str, Any]:
        if self._remote_client is not None:
            payload = self._remote_payloads.get(session_id)
            if payload is None:
                self._load_remote_state(session_id)
                payload = self._remote_payloads[session_id]
            return dict(payload["table"])
        return self._read_local_table(session_id)

    def _read_local_table(self, session_id: str) -> dict[str, Any]:
        try:
            return json.loads(
                (self._directory(session_id) / "table.json").read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as exc:
            raise OperationStoreError("Bảng dữ liệu chuẩn hóa không hợp lệ") from exc

    @staticmethod
    def _materialize_payload(
        table_payload: dict[str, Any], revision: DerivedRevision
    ) -> InputTable:
        rows: list[dict[str, Any]] = []
        for item in table_payload["rows"]:
            values = dict(item["values"])
            values.update(revision.overlays.get(str(item["row_id"]), {}))
            rows.append(values)
        return InputTable(
            headers=list(table_payload["headers"]),
            rows=rows,
            sheet_name=table_payload.get("sheet_name"),
            header_row_index=int(table_payload.get("header_row_index") or 0),
        )

    def _save_session(
        self, session: NormalizedSession, table_payload: dict[str, Any] | None = None
    ) -> None:
        if self._remote_client is not None:
            self._save_remote_state(session, table_payload or self._read_table(session.session_id))
            return
        payload = session.model_dump(mode="json")
        self._atomic_write(self._directory(session.session_id) / "session.json", payload)

    def _load_remote_state(
        self, session_id: str, *, migrate_legacy: bool = True
    ) -> tuple[NormalizedSession, dict[str, Any]]:
        run_id = self._remote_run_id
        if not run_id:
            raise OperationStoreError("Conversion run binding là bắt buộc")
        try:
            result = self._remote_client.get_state(session_id=session_id, run_id=run_id)
        except OperationStoreClientError:
            raise
        except Exception as exc:
            raise OperationStoreError("Không tải được session state từ Node") from exc
        state = result.get("state") if isinstance(result, dict) and "state" in result else result
        if not isinstance(state, dict):
            raise OperationStoreError("Session state từ Node không hợp lệ")
        metadata = result.get("session") if isinstance(result, dict) else None
        if not isinstance(metadata, dict):
            raise OperationStoreError("Node thiếu persisted session metadata")
        stored_revision = metadata.get("revision")
        stored_sha256 = str(metadata.get("sha256") or "").strip().lower()
        if (
            not isinstance(stored_revision, int)
            or stored_revision < 1
            or not _is_sha256(stored_sha256)
        ):
            raise OperationStoreError("Node trả về persisted session metadata không hợp lệ")
        self._remote_storage_revisions[session_id] = stored_revision
        self._remote_state_sha256s[session_id] = stored_sha256
        if (
            state.get("contract") == STUDENT_METADATA_STATE_CONTRACT
            and not isinstance(state.get("table"), dict)
        ):
            if not migrate_legacy:
                raise OperationStoreError(
                    "Legacy student session migration chưa khả dụng; vui lòng thử lại"
                )
            return self._migrate_legacy_student_state(session_id, state)
        session, table_payload = self._validate_remote_state(session_id, state)
        self._remote_payloads[session_id] = {"session": session, "table": table_payload}
        return session, table_payload

    def _migrate_legacy_student_state(
        self, session_id: str, state: dict[str, Any]
    ) -> tuple[NormalizedSession, dict[str, Any]]:
        session = self._validate_remote_session(session_id, state)
        self._state_contracts[session_id] = STUDENT_METADATA_STATE_CONTRACT
        table_payload = self._recover_legacy_student_table(session)
        try:
            self._save_remote_state(session, table_payload)
        except OperationStoreConflictError:
            return self._load_remote_state(session_id, migrate_legacy=False)
        self._remove_replica_local_directory(session_id)
        persisted = self._remote_payloads[session_id]
        return persisted["session"], dict(persisted["table"])

    def _recover_legacy_student_table(
        self, session: NormalizedSession
    ) -> dict[str, Any]:
        local_path = self._directory(session.session_id) / "table.json"
        if local_path.is_file():
            try:
                local_payload = self._read_local_table(session.session_id)
                if self._table_payload_matches_session(local_payload, session):
                    return local_payload
            except OperationStoreError:
                pass

        try:
            content = self._remote_client.get_artifact(
                session_id=session.session_id,
                run_id=self._remote_run_id,
                kind="upload",
                revision=None,
            )
            context = self._revision(session, session.active_revision).context
            upload_metadata = context.get("upload_metadata")
            filename = str(
                upload_metadata.get("filename")
                if isinstance(upload_metadata, dict)
                else "legacy-upload.xlsx"
            )
            suffix = Path(filename).suffix.lower()
            if suffix not in {".xls", ".xlsx"}:
                suffix = ".xlsx"
            with tempfile.TemporaryDirectory(prefix="legacy-operation-drain-") as directory:
                source_path = Path(directory) / f"input{suffix}"
                source_path.write_bytes(content)
                recovered = read_input_table(source_path)
            payload = self._table_payload(recovered)
            if self._table_payload_matches_session(payload, session):
                return payload
        except OperationStoreClientError as exc:
            if exc.status_code == 404:
                raise OperationStoreError(
                    "Legacy student session has no durable table source; operator drain recovery is required before release"
                ) from exc
            raise OperationStoreError(
                "Legacy student session migration source is temporarily unavailable while drain remains active"
            ) from exc
        except Exception as exc:
            raise OperationStoreError(
                "Legacy student session migration source is temporarily unavailable while drain remains active"
            ) from exc
        raise OperationStoreError(
            "Legacy student session has no durable table source; operator drain recovery is required before release"
        )

    @staticmethod
    def _table_payload(table: InputTable) -> dict[str, Any]:
        return {
            "headers": list(table.headers),
            "rows": [
                {"row_id": f"r{index}", "values": _json_safe(row)}
                for index, row in enumerate(table.rows, start=1)
            ],
            "sheet_name": table.sheet_name,
            "header_row_index": table.header_row_index,
        }

    @staticmethod
    def _table_payload_matches_session(
        table_payload: dict[str, Any], session: NormalizedSession
    ) -> bool:
        try:
            current = OperationStore._revision(session, session.active_revision)
            computed = _state_hash(table_payload, current.overlays, current.context)
        except (KeyError, TypeError, ValueError, OperationStoreError):
            return False
        return current.state_hash == session.state_hash == computed

    def _remove_replica_local_directory(self, session_id: str) -> None:
        directory = self._directory(session_id)
        with _OPERATION_SESSION_DIRECTORY_LOCK:
            if directory.exists() or directory.is_symlink():
                _remove_operation_session_directory(self.root, directory)

    def _save_remote_state(
        self, session: NormalizedSession, table_payload: dict[str, Any]
    ) -> None:
        run_id = self._remote_run_id or self._run_id_from_session(session)
        if not run_id:
            raise OperationStoreError("Conversion run binding là bắt buộc")
        self._remote_run_id = run_id
        expected_revision = self._remote_storage_revisions.get(session.session_id, 0)
        expected_state_sha256 = self._remote_state_sha256s.get(session.session_id, "")
        storage_revision = expected_revision + 1
        state = {
            "schema_version": 1,
            "contract": self._state_contracts.get(session.session_id)
            or "operation_state_v1",
            "session": session.model_dump(mode="json"),
            "table": table_payload,
        }
        try:
            result = self._remote_client.put_state(
                session_id=session.session_id,
                run_id=run_id,
                revision=storage_revision,
                expected_revision=expected_revision,
                expected_state_sha256=expected_state_sha256,
                state=state,
                expires_at=session.expires_at,
            )
        except OperationStoreClientError as exc:
            self._raise_remote_error(exc)
        except Exception as exc:
            raise OperationStoreError("Không lưu được session state vào Node") from exc
        persisted_state = result.get("state") if isinstance(result, dict) else None
        metadata = result.get("session") if isinstance(result, dict) else None
        remote_revision = metadata.get("revision") if isinstance(metadata, dict) else None
        remote_sha256 = str(
            metadata.get("sha256") if isinstance(metadata, dict) else ""
        ).strip().lower()
        if (
            remote_revision != storage_revision
            or not _is_sha256(remote_sha256)
            or not isinstance(persisted_state, dict)
        ):
            raise OperationStoreError("Node không trả về persisted session state hợp lệ")
        persisted_session, persisted_table = self._validate_remote_state(
            session.session_id,
            persisted_state,
        )
        self._remote_storage_revisions[session.session_id] = remote_revision
        self._remote_state_sha256s[session.session_id] = remote_sha256
        self._remote_payloads[session.session_id] = {
            "session": persisted_session,
            "table": persisted_table,
        }

    @staticmethod
    def _run_id_from_session(session: NormalizedSession) -> str:
        if not session.revisions:
            return ""
        return str(session.revisions[0].context.get("conversion_run_id") or "").strip()

    def _validate_remote_state(
        self, session_id: str, state: dict[str, Any]
    ) -> tuple[NormalizedSession, dict[str, Any]]:
        remote_session = self._validate_remote_session(session_id, state)
        table_payload = state.get("table")
        contract = state.get("contract")
        if contract == STUDENT_METADATA_STATE_CONTRACT:
            self._state_contracts[session_id] = STUDENT_METADATA_STATE_CONTRACT
        session = remote_session
        if not isinstance(table_payload, dict):
            raise OperationStoreError("Session state từ Node không hợp lệ")
        if not isinstance(table_payload.get("headers"), list) or not isinstance(
            table_payload.get("rows"), list
        ):
            raise OperationStoreError("Bảng session từ Node không hợp lệ")
        current = OperationStore._revision(session, session.active_revision)
        computed = _state_hash(table_payload, current.overlays, current.context)
        if current.state_hash != session.state_hash or computed != session.state_hash:
            raise OperationStoreError("Session state hash không hợp lệ")
        return session, table_payload

    @staticmethod
    def _validate_remote_session(
        session_id: str, state: dict[str, Any]
    ) -> NormalizedSession:
        raw_session = state.get("session")
        if not isinstance(raw_session, dict):
            raise OperationStoreError("Session state từ Node không hợp lệ")
        try:
            remote_session = NormalizedSession.model_validate(raw_session)
        except ValueError as exc:
            raise OperationStoreError("Session metadata từ Node không hợp lệ") from exc
        if remote_session.session_id != session_id:
            raise OperationStoreError("Session binding từ Node không hợp lệ")
        if remote_session.expires_at <= datetime.now(timezone.utc):
            raise OperationStoreExpiredError("Phiên chuyển đổi đã hết hạn")
        return remote_session

    def _purge_local_state(self, session_id: str) -> None:
        self._remote_payloads.pop(session_id, None)
        self._remote_storage_revisions.pop(session_id, None)
        self._remote_state_sha256s.pop(session_id, None)
        self._state_contracts.pop(session_id, None)
        directory = self._directory(session_id)
        with _OPERATION_SESSION_DIRECTORY_LOCK:
            if directory.exists() or directory.is_symlink():
                _remove_operation_session_directory(self.root, directory)
            staging_prefix = f".creating-{session_id}-"
            for candidate in self.root.iterdir():
                if candidate.name.startswith(staging_prefix) and (
                    candidate.is_dir() or candidate.is_symlink()
                ):
                    _remove_operation_session_directory(self.root, candidate)

    def purge_local_session_state(self, session_id: str) -> bool:
        self._purge_local_state(session_id)
        return not self._directory(session_id).exists()

    def purge_session_state(self, session_id: str) -> dict[str, bool]:
        with self._purge_fence(session_id):
            remote_deleted = self._remote_client is None
            if self._remote_client is not None:
                run_id = self._remote_run_id
                try:
                    result = self._remote_client.delete_session_artifacts(
                        session_id=session_id,
                        run_id=run_id,
                    )
                    remote_deleted = bool(
                        result.get("success") is True
                        and str(result.get("session_id") or "") == str(session_id)
                        and str(result.get("run_id") or "") == str(run_id)
                        and result.get("purge_scope") == "all_artifacts"
                        and result.get("remaining_metadata") == 0
                        and result.get("remaining_bytes") == 0
                        and result.get("remote_operation_session_deleted") is True
                    )
                except Exception:
                    remote_deleted = False
            try:
                local_deleted = self.purge_local_session_state(session_id)
            except (OSError, OperationStoreError):
                local_deleted = False
            completed = local_deleted and remote_deleted
            if completed:
                self._write_lifecycle_state(session_id, "purged")
            return {
                "local_operation_session_deleted": local_deleted,
                "remote_operation_session_deleted": remote_deleted,
                "operation_session_deleted": completed,
            }

    def _rollback_remote_creation(self, session: NormalizedSession) -> bool:
        if self._remote_client is None:
            return True
        run_id = self._remote_run_id or self._run_id_from_session(session)
        try:
            result = self._remote_client.delete_session_artifacts(
                session_id=session.session_id,
                run_id=run_id,
            )
        except Exception:
            return False
        if not isinstance(result, dict):
            return False
        return bool(
            result.get("success") is True
            and str(result.get("session_id") or "") == session.session_id
            and str(result.get("run_id") or "") == run_id
            and result.get("purge_scope") == "all_artifacts"
            and result.get("remaining_metadata") == 0
            and result.get("remaining_bytes") == 0
            and result.get("remote_operation_session_deleted") is True
        )

    def has_local_session_state(self, session_id: str) -> bool:
        directory = self._directory(session_id)
        return directory.exists() or directory.is_symlink()

    def state_contract(self, session_id: str) -> str | None:
        return self._state_contracts.get(session_id)

    def bound_remote_session_id(self) -> str:
        return str(getattr(self._remote_client, "session_id", "") or "").strip()

    def persisted_state_binding(self, session_id: str) -> dict[str, Any]:
        if session_id not in self._remote_storage_revisions:
            self._load_remote_state(session_id)
        return {
            "revision": self._remote_storage_revisions[session_id],
            "sha256": self._remote_state_sha256s[session_id],
        }

    @staticmethod
    def _raise_remote_error(exc: OperationStoreClientError) -> None:
        if OperationStore._remote_error_requires_purge(exc):
            raise OperationStoreExpiredError("Phiên chuyển đổi đã hết hạn") from exc
        if exc.status_code == 409:
            raise OperationStoreConflictError(str(exc)) from exc
        if exc.status_code in {401, 403}:
            raise ConversionContextError(str(exc), status_code=exc.status_code) from exc
        if exc.status_code == 404:
            raise OperationStoreError("Session not found") from exc
        raise OperationStoreError(str(exc)) from exc

    @staticmethod
    def _remote_error_requires_purge(exc: OperationStoreClientError) -> bool:
        return exc.status_code == 410 and exc.code == "ARTIFACT_EXPIRED"

    @staticmethod
    def _assert_current(
        session: NormalizedSession,
        expected_revision: int,
        expected_state_hash: str,
    ) -> None:
        if (
            session.active_revision != expected_revision
            or session.state_hash != expected_state_hash
        ):
            raise OperationStoreConflictError("Phiên chuyển đổi đã thay đổi")

    @staticmethod
    def _revision(session: NormalizedSession, revision: int) -> DerivedRevision:
        for item in session.revisions:
            if item.revision == revision:
                return item
        raise OperationStoreError("Revision không tồn tại")

    def _directory(self, session_id: str) -> Path:
        safe_id = "".join(
            char for char in str(session_id) if char.isalnum() or char in {"-", "_"}
        )
        if not safe_id or safe_id != str(session_id):
            raise OperationStoreError("Session ID không hợp lệ")
        return self.root / safe_id

    @contextmanager
    def _lock(self, session_id: str) -> Iterator[None]:
        with self._write_lease(session_id):
            yield

    @contextmanager
    def _write_lease(
        self,
        session_id: str,
        *,
        initialize: bool = False,
    ) -> Iterator[None]:
        cls = type(self)
        with cls._locks_guard:
            thread_lock = cls._locks.setdefault(session_id, threading.RLock())
        with thread_lock:
            key = (str(self._lifecycle_root.resolve()), str(session_id))
            depths = getattr(cls._lease_depths, "values", {})
            if depths.get(key, 0) > 0:
                lifecycle = self._read_lifecycle_state(session_id)
                if lifecycle is None or lifecycle.get("status") != "active":
                    raise OperationStoreError(
                        "Operation session is purging or purged"
                    )
                depths[key] += 1
                cls._lease_depths.values = depths
                try:
                    yield
                finally:
                    depths[key] -= 1
                    if depths[key] == 0:
                        depths.pop(key, None)
                return
            with _operation_fence_locks(self._lifecycle_root, session_id):
                lifecycle = self._read_lifecycle_state(session_id)
                if lifecycle is None:
                    if (
                        not initialize
                        and self._remote_client is None
                        and not self._directory(session_id).exists()
                    ):
                        raise OperationStoreError("Phiên chuyển đổi không tồn tại")
                    self._write_lifecycle_state(session_id, "active")
                    lifecycle = {"status": "active"}
                if lifecycle.get("status") != "active":
                    raise OperationStoreError(
                        "Operation session is purging or purged"
                    )
                depths[key] = 1
                cls._lease_depths.values = depths
                try:
                    yield
                finally:
                    depths.pop(key, None)

    @contextmanager
    def _purge_fence(self, session_id: str) -> Iterator[None]:
        cls = type(self)
        with cls._locks_guard:
            thread_lock = cls._locks.setdefault(session_id, threading.RLock())
        with thread_lock:
            with _operation_fence_locks(self._lifecycle_root, session_id):
                lifecycle = self._read_lifecycle_state(session_id)
                if lifecycle is None or lifecycle.get("status") == "active":
                    self._write_lifecycle_state(session_id, "purging")
                yield

    def _assert_lifecycle_active(self, session_id: str) -> None:
        lifecycle = self._read_lifecycle_state(session_id)
        if lifecycle is not None and lifecycle.get("status") != "active":
            raise OperationStoreError("Operation session is purging or purged")

    def _lifecycle_lock_path(self, session_id: str) -> Path:
        self._directory(session_id)
        return _operation_fence_lock_path(self._lifecycle_root, session_id)

    def _lifecycle_state_path(self, session_id: str) -> Path:
        self._directory(session_id)
        return self._lifecycle_root / f"{_operation_fence_key(session_id)}.json"

    def _legacy_lifecycle_state_path(self, session_id: str) -> Path:
        self._directory(session_id)
        return self._lifecycle_root / f"{session_id}.json"

    def _read_lifecycle_state(self, session_id: str) -> dict[str, Any] | None:
        paths = _operation_fence_state_paths(self._lifecycle_root, session_id)
        path = paths[0][1]
        legacy_path = self._legacy_lifecycle_state_path(session_id)
        if legacy_path.is_file():
            _migrate_legacy_lifecycle_state(
                lifecycle_root=self._lifecycle_root,
                session_id=session_id,
                hashed_path=path,
            )
        observed: list[dict[str, Any]] = []
        for key_id, candidate in paths:
            if not candidate.is_file():
                continue
            payload = _read_lifecycle_payload(candidate, expected_schema=2)
            observed.append(_upgrade_lifecycle_payload(payload, session_id, key_id))
        if not observed:
            return None
        merged = observed[0]
        for payload in observed[1:]:
            merged = _merged_lifecycle_payload(merged, payload, session_id=session_id)
        for _key_id, candidate in paths:
            if not candidate.is_file() or _read_lifecycle_payload(
                candidate,
                expected_schema=2,
            ) != merged:
                self._atomic_write(candidate, merged)
        return merged

    def _write_lifecycle_state(self, session_id: str, status: str) -> None:
        if status not in {"active", "purging", "purged"}:
            raise OperationStoreError("Operation lifecycle fence không hợp lệ")
        current_time = datetime.now(timezone.utc)
        current = self._read_lifecycle_state(session_id)
        payload = _operation_fence_payload(status, current_time, session_id=session_id)
        if current is not None:
            payload = _merged_lifecycle_payload(current, payload, session_id=session_id)
        for _key_id, path in _operation_fence_state_paths(
            self._lifecycle_root,
            session_id,
        ):
            self._atomic_write(path, payload)

    @staticmethod
    def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(
            f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("w", encoding="utf-8", newline="") as handle:
                handle.write(
                    json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                )
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _local_session_expiry(directory: Path) -> datetime | None:
    path = directory / "session.json"
    if not path.is_file():
        path = directory / ".creating.json"
        if not path.is_file():
            if directory.name.startswith(".creating-"):
                try:
                    created_at = datetime.fromtimestamp(
                        directory.stat().st_mtime,
                        timezone.utc,
                    )
                    return created_at + timedelta(
                        seconds=_creation_grace_seconds()
                    )
                except OSError:
                    return None
            return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        raw_value = payload.get("expires_at")
        if isinstance(raw_value, (int, float)):
            return datetime.fromtimestamp(raw_value, timezone.utc)
        parsed = datetime.fromisoformat(str(raw_value or "").replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
        return None


def _creation_registry_key(root: Path, directory: Path) -> tuple[str, str]:
    return (str(root.resolve()), directory.name)


def _creation_grace_seconds() -> int:
    try:
        configured = int(
            os.getenv(
                "OPERATION_SESSION_CREATION_GRACE_SECONDS",
                str(DEFAULT_OPERATION_SESSION_CREATION_GRACE_SECONDS),
            )
        )
    except ValueError:
        configured = DEFAULT_OPERATION_SESSION_CREATION_GRACE_SECONDS
    return min(max(configured, 30), 3600)


def _operation_fence_secret() -> bytes:
    secret = next(
        (
            os.getenv(name, "").strip()
            for name in (
                "OPERATION_FENCE_HMAC_SECRET",
                "CONVERSION_CONTEXT_SECRET",
                "CONVERTER_SERVICE_TOKEN",
            )
            if os.getenv(name, "").strip()
        ),
        "",
    )
    encoded = secret.encode("utf-8")
    if len(encoded) < 32:
        raise OperationStoreError(
            "Operation lifecycle HMAC secret must contain at least 32 bytes"
        )
    return encoded


def _operation_fence_key_ring() -> dict[str, Any]:
    active_key_id = os.getenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1").strip()
    if not active_key_id or any(
        not (character.isalnum() or character in {".", "_", "-"})
        for character in active_key_id
    ) or len(active_key_id) > 64:
        raise OperationStoreError("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID is invalid")
    raw_previous = os.getenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}").strip() or "{}"
    try:
        previous = json.loads(raw_previous)
    except json.JSONDecodeError as exc:
        raise OperationStoreError(
            "OPERATION_FENCE_HMAC_PREVIOUS_KEYS must be a JSON object"
        ) from exc
    if not isinstance(previous, dict):
        raise OperationStoreError(
            "OPERATION_FENCE_HMAC_PREVIOUS_KEYS must be a JSON object"
        )
    entries = [(active_key_id, _operation_fence_secret())]
    for raw_key_id, raw_secret in previous.items():
        key_id = str(raw_key_id or "").strip()
        secret = str(raw_secret or "").strip()
        if (
            not key_id
            or key_id == active_key_id
            or len(key_id) > 64
            or any(
                not (character.isalnum() or character in {".", "_", "-"})
                for character in key_id
            )
        ):
            raise OperationStoreError(
                "OPERATION_FENCE_HMAC_PREVIOUS_KEYS contains an invalid key id"
            )
        encoded_secret = secret.encode("utf-8")
        if len(encoded_secret) < 32:
            raise OperationStoreError(
                "Every previous operation fence HMAC key must contain at least 32 bytes"
            )
        entries.append((key_id, encoded_secret))
    if len({secret for _key_id, secret in entries}) != len(entries):
        raise OperationStoreError("Operation fence HMAC key ids need distinct secrets")

    horizon_text = os.getenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", "").strip()
    horizon = None
    if horizon_text:
        try:
            horizon = datetime.fromisoformat(horizon_text.replace("Z", "+00:00"))
            if horizon.tzinfo is None:
                horizon = horizon.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise OperationStoreError(
                "OPERATION_FENCE_HMAC_ROTATION_HORIZON is invalid"
            ) from exc
    if len(entries) > 1 and horizon is None:
        raise OperationStoreError(
            "OPERATION_FENCE_HMAC_ROTATION_HORIZON is required during key rotation"
        )
    if (
        horizon is not None
        and horizon > datetime.now(timezone.utc)
        and len(entries) == 1
    ):
        raise OperationStoreError(
            "Previous operation fence key cannot be removed before the retention horizon"
        )
    return {
        "active_key_id": active_key_id,
        "entries": entries,
        "previous_key_ids": [key_id for key_id, _secret in entries[1:]],
        "rotation_horizon": horizon,
    }


def _operation_fence_aliases(session_id: str) -> list[tuple[str, str]]:
    normalized = str(session_id or "").strip()
    if not normalized:
        raise OperationStoreError("Session ID không hợp lệ")
    return [
        (
            key_id,
            hmac.new(secret, normalized.encode("utf-8"), hashlib.sha256).hexdigest(),
        )
        for key_id, secret in _operation_fence_key_ring()["entries"]
    ]


def _operation_fence_key(session_id: str) -> str:
    return _operation_fence_aliases(session_id)[0][1]


def _operation_digest(session_id: str) -> str:
    normalized = str(session_id or "").strip()
    if not normalized:
        raise OperationStoreError("Session ID không hợp lệ")
    return hashlib.sha256(
        f"operation-fence-lock\0{normalized}".encode("utf-8")
    ).hexdigest()


def _operation_fence_state_paths(
    lifecycle_root: Path,
    session_id: str,
) -> list[tuple[str, Path]]:
    return [
        (key_id, lifecycle_root / f"{operation_key}.json")
        for key_id, operation_key in _operation_fence_aliases(session_id)
    ]


def _operation_fence_lock_path(lifecycle_root: Path, session_id: str) -> Path:
    return lifecycle_root / f".{_operation_digest(session_id)}.lock"


def _operation_fence_lock_paths(
    lifecycle_root: Path,
    session_id: str,
) -> list[Path]:
    paths = {_operation_fence_lock_path(lifecycle_root, session_id)}
    paths.update(
        lifecycle_root / f"{operation_key}.lock"
        for _key_id, operation_key in _operation_fence_aliases(session_id)
    )
    return sorted(paths, key=lambda path: path.name)


@contextmanager
def _operation_fence_locks(
    lifecycle_root: Path,
    session_id: str,
) -> Iterator[None]:
    with ExitStack() as stack:
        for path in _operation_fence_lock_paths(lifecycle_root, session_id):
            stack.enter_context(_file_lock(path))
        yield


def _operation_fence_key_canary(key_id: str, secret: bytes) -> str:
    return hmac.new(
        secret,
        f"ez-format:operation-fence-key-canary:v1\0{key_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _operation_fence_key_canary_path(lifecycle_root: Path, key_id: str) -> Path:
    key_hash = hashlib.sha256(key_id.encode("utf-8")).hexdigest()
    # HEAD cleanup treats every root-level JSON file as a lifecycle fence.
    return lifecycle_root / f".key-canary-{key_hash}.canary"


def _assert_operation_fence_key_canaries(
    lifecycle_root: Path,
    key_ring: dict[str, Any],
) -> None:
    configured_key_ids = {
        key_id for key_id, _secret in key_ring["entries"]
    }
    lock_path = lifecycle_root / ".key-canary.lock"
    with _file_lock(lock_path):
        observed_by_key_id: dict[str, dict[str, Any]] = {}
        current_time = datetime.now(timezone.utc)
        for path in lifecycle_root.glob(".key-canary-*.canary"):
            try:
                observed = json.loads(path.read_text(encoding="utf-8"))
                key_id = str(observed.get("key_id") or "")
                fingerprint = str(observed.get("fingerprint") or "")
                required_until = _lifecycle_timestamp(observed, "required_until")
            except (OSError, json.JSONDecodeError, OperationStoreError) as exc:
                raise OperationStoreError("Operation fence key canary is invalid") from exc
            if (
                observed.get("schema_version") != 1
                or not key_id
                or len(key_id) > 64
                or any(
                    not (character.isalnum() or character in {".", "_", "-"})
                    for character in key_id
                )
                or len(fingerprint) != 64
                or any(character not in "0123456789abcdef" for character in fingerprint)
                or path != _operation_fence_key_canary_path(lifecycle_root, key_id)
            ):
                raise OperationStoreError("Operation fence key canary is invalid")
            observed_by_key_id[key_id] = observed
            if (
                key_id not in configured_key_ids
                and required_until is not None
                and required_until > current_time
            ):
                raise OperationStoreError(
                    "Previous operation fence key cannot be removed before the retention horizon"
                )

        for key_id in key_ring["previous_key_ids"]:
            if key_id not in observed_by_key_id:
                raise OperationStoreError(
                    "Previous operation fence key canary is missing; "
                    "deploy a one-key canary bootstrap first"
                )

        for key_id, secret in key_ring["entries"]:
            fingerprint = _operation_fence_key_canary(key_id, secret)
            observed = observed_by_key_id.get(key_id)
            if observed is not None and observed.get("fingerprint") != fingerprint:
                raise OperationStoreError(
                    f"Operation fence same key id {key_id} uses different secret material"
                )
            existing_horizon = (
                _lifecycle_timestamp(observed, "required_until")
                if observed is not None
                else None
            )
            if (
                key_id in key_ring["previous_key_ids"]
                and existing_horizon is not None
                and existing_horizon > key_ring["rotation_horizon"]
            ):
                raise OperationStoreError(
                    "Operation fence key rotation horizon cannot be shortened"
                )

        for key_id, secret in key_ring["entries"]:
            path = _operation_fence_key_canary_path(lifecycle_root, key_id)
            observed = observed_by_key_id.get(key_id)
            payload: dict[str, Any] = {
                "schema_version": 1,
                "key_id": key_id,
                "fingerprint": _operation_fence_key_canary(key_id, secret),
            }
            if key_id in key_ring["previous_key_ids"]:
                payload["required_until"] = key_ring["rotation_horizon"].isoformat()
            if observed is not None:
                existing_horizon = _lifecycle_timestamp(observed, "required_until")
                requested_horizon = _lifecycle_timestamp(payload, "required_until")
                if existing_horizon is not None and requested_horizon is None:
                    payload["required_until"] = existing_horizon.isoformat()
            OperationStore._atomic_write(path, payload)


def _assert_operation_fence_key_coverage(lifecycle_root: Path) -> None:
    key_ring = _operation_fence_key_ring()
    _assert_operation_fence_key_canaries(lifecycle_root, key_ring)
    configured_key_ids = {
        key_id for key_id, _secret in key_ring["entries"]
    }
    current_time = datetime.now(timezone.utc)
    for state_path in lifecycle_root.glob("*.json"):
        if state_path.name.startswith(".key-canary-"):
            continue
        try:
            payload = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise OperationStoreError("Operation lifecycle fence không hợp lệ") from exc
        schema_version = payload.get("schema_version")
        if schema_version == 1:
            continue
        if schema_version not in {2, 3}:
            raise OperationStoreError("Operation lifecycle fence không hợp lệ")
        key_ids = {
            str(key_id)
            for key_id in payload.get("key_ids", [])
            if str(key_id).strip()
        }
        required_previous = {
            str(key_id)
            for key_id in payload.get("required_previous_key_ids", [])
            if str(key_id).strip()
        }
        horizon = _lifecycle_timestamp(payload, "key_ring_retain_until")
        if (
            horizon is not None
            and horizon > current_time
            and not required_previous.issubset(configured_key_ids)
        ):
            raise OperationStoreError(
                "Previous operation fence key cannot be removed before the retention horizon"
            )
        if (
            payload.get("status") in {"active", "purging"}
            and key_ids
            and key_ids.isdisjoint(configured_key_ids)
        ):
            raise OperationStoreError(
                "Active operation fence has no configured lifecycle key"
            )


def _operation_fence_retention_seconds() -> int:
    values = [MIN_OPERATION_FENCE_RETENTION_SECONDS, _ttl_seconds()]
    for name in (
        "OPERATION_FENCE_RETENTION_SECONDS",
        "STUDENT_UPLOAD_RETENTION_SECONDS",
        "CONVERTER_ARTIFACT_TTL_SECONDS",
    ):
        try:
            values.append(max(0, int(os.getenv(name, "0"))))
        except ValueError:
            continue
    return max(values)


def _operation_fence_payload(
    status: str,
    current_time: datetime,
    *,
    session_id: str,
) -> dict[str, Any]:
    key_ring = _operation_fence_key_ring()
    retain_until = current_time + timedelta(
        seconds=_operation_fence_retention_seconds()
    )
    payload: dict[str, Any] = {
        "schema_version": 2,
        "operation_digest": _operation_digest(session_id),
        "key_ids": [key_id for key_id, _secret in key_ring["entries"]],
        "required_previous_key_ids": key_ring["previous_key_ids"],
        "status": status,
        "updated_at": current_time.isoformat(),
        "retain_until": retain_until.isoformat(),
    }
    if key_ring["rotation_horizon"] is not None:
        payload["key_ring_retain_until"] = key_ring[
            "rotation_horizon"
        ].isoformat()
    if status == "purged":
        payload["purge_after"] = retain_until.isoformat()
    return payload


def _read_lifecycle_payload(
    path: Path,
    *,
    expected_schema: int,
    session_id: str | None = None,
) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ") from exc
    schema_version = payload.get("schema_version")
    if schema_version != expected_schema and not (
        expected_schema == 2 and schema_version == 3
    ):
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    if payload.get("status") not in {"active", "purging", "purged"}:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    if expected_schema == 1 and str(payload.get("session_id") or "") != session_id:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    if expected_schema == 2 and "session_id" in payload:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    if schema_version == 3 or "key_ids" in payload:
        if not isinstance(payload.get("key_ids"), list) or not payload["key_ids"]:
            raise OperationStoreError("Operation lifecycle fence không hợp lệ")
        if not isinstance(payload.get("required_previous_key_ids"), list):
            raise OperationStoreError("Operation lifecycle fence không hợp lệ")
        if not isinstance(payload.get("operation_digest"), str) or len(
            payload["operation_digest"]
        ) != 64:
            raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    return payload


def _upgrade_lifecycle_payload(
    payload: dict[str, Any],
    session_id: str,
    key_id: str,
) -> dict[str, Any]:
    upgraded = dict(payload)
    if upgraded.get("operation_digest") not in {None, _operation_digest(session_id)}:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    upgraded.pop("session_id", None)
    upgraded.update(
        {
            "schema_version": 2,
            "operation_digest": _operation_digest(session_id),
            "key_ids": sorted({
                key_id,
                *(str(value) for value in upgraded.get("key_ids", []) if str(value)),
            }),
            "required_previous_key_ids": list(
                upgraded.get("required_previous_key_ids", [])
            ),
        }
    )
    return upgraded


def _lifecycle_timestamp(payload: dict[str, Any], field: str) -> datetime | None:
    raw_value = payload.get(field)
    if raw_value in {None, ""}:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw_value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _merged_lifecycle_payload(
    current: dict[str, Any] | None,
    legacy: dict[str, Any],
    *,
    session_id: str,
) -> dict[str, Any]:
    status_rank = {"active": 0, "purging": 1, "purged": 2}
    status = max(
        (payload["status"] for payload in (current, legacy) if payload is not None),
        key=status_rank.__getitem__,
    )
    current_time = datetime.now(timezone.utc)
    merged = _operation_fence_payload(status, current_time, session_id=session_id)
    merged["key_ids"] = sorted({
        str(key_id)
        for payload in (current, legacy, merged)
        if payload is not None
        for key_id in payload.get("key_ids", [])
        if str(key_id).strip()
    })
    merged["required_previous_key_ids"] = sorted({
        str(key_id)
        for payload in (current, legacy, merged)
        if payload is not None
        for key_id in payload.get("required_previous_key_ids", [])
        if str(key_id).strip()
    })
    key_ring_horizons = [
        value
        for payload in (current, legacy, merged)
        if payload is not None
        for value in (_lifecycle_timestamp(payload, "key_ring_retain_until"),)
        if value is not None
    ]
    if key_ring_horizons:
        merged["key_ring_retain_until"] = max(key_ring_horizons).isoformat()
    retained = [
        value
        for payload in (current, legacy)
        if payload is not None
        for value in (_lifecycle_timestamp(payload, "retain_until"),)
        if value is not None
    ]
    if retained:
        retain_until = max(
            datetime.fromisoformat(merged["retain_until"]),
            *retained,
        )
        merged["retain_until"] = retain_until.isoformat()
    if status == "purged":
        purge_candidates = [datetime.fromisoformat(merged["purge_after"])]
        for payload in (current, legacy):
            if payload is not None:
                value = _lifecycle_timestamp(payload, "purge_after")
                if value is not None:
                    purge_candidates.append(value)
        purge_after = max(
            datetime.fromisoformat(merged["retain_until"]),
            *purge_candidates,
        )
        merged["purge_after"] = purge_after.isoformat()
    return merged


def _migrate_legacy_lifecycle_state(
    *,
    lifecycle_root: Path,
    session_id: str,
    hashed_path: Path,
) -> dict[str, Any]:
    legacy_path = lifecycle_root / f"{session_id}.json"
    legacy_lock = lifecycle_root / f"{session_id}.lock"
    with _file_lock(legacy_lock):
        if not legacy_path.is_file():
            if not hashed_path.is_file():
                raise OperationStoreError("Operation lifecycle fence không hợp lệ")
            merged = _read_lifecycle_payload(hashed_path, expected_schema=2)
        else:
            legacy = _read_lifecycle_payload(
                legacy_path,
                expected_schema=1,
                session_id=session_id,
            )
            current = (
                _read_lifecycle_payload(hashed_path, expected_schema=2)
                if hashed_path.is_file()
                else None
            )
            upgraded_legacy = _upgrade_lifecycle_payload(
                legacy,
                session_id,
                _operation_fence_key_ring()["active_key_id"],
            )
            upgraded_current = (
                _upgrade_lifecycle_payload(
                    current,
                    session_id,
                    _operation_fence_key_ring()["active_key_id"],
                )
                if current is not None
                else None
            )
            merged = _merged_lifecycle_payload(
                upgraded_current,
                upgraded_legacy,
                session_id=session_id,
            )
            OperationStore._atomic_write(hashed_path, merged)
            try:
                legacy_path.unlink()
            except OSError as exc:
                raise OperationStoreError(
                    "Operation lifecycle plaintext fence migration failed"
                ) from exc
    try:
        legacy_lock.unlink(missing_ok=True)
    except OSError as exc:
        raise OperationStoreError(
            "Operation lifecycle plaintext fence cleanup failed"
        ) from exc
    return merged


def _migrate_legacy_lifecycle_path(state_path: Path) -> Path:
    try:
        observed = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("Operation lifecycle fence không hợp lệ") from exc
    if observed.get("schema_version") != 1:
        return state_path
    session_id = str(observed.get("session_id") or "").strip()
    if not session_id or state_path.name != f"{session_id}.json" or any(
        not (character.isalnum() or character in {"-", "_"})
        for character in session_id
    ):
        raise OperationStoreError("Operation lifecycle fence không hợp lệ")
    lifecycle_root = state_path.parent
    hashed_path = lifecycle_root / f"{_operation_fence_key(session_id)}.json"
    with OperationStore._locks_guard:
        thread_lock = OperationStore._locks.setdefault(session_id, threading.RLock())
    with thread_lock:
        with _operation_fence_locks(lifecycle_root, session_id):
            _migrate_legacy_lifecycle_state(
                lifecycle_root=lifecycle_root,
                session_id=session_id,
                hashed_path=hashed_path,
            )
    return hashed_path


def _purged_fence_is_expired(
    payload: dict[str, Any],
    current_time: datetime,
) -> bool:
    if payload.get("status") != "purged":
        return False
    updated_at = _lifecycle_timestamp(payload, "updated_at")
    retain_until = _lifecycle_timestamp(payload, "retain_until")
    purge_after = _lifecycle_timestamp(payload, "purge_after")
    if updated_at is None or retain_until is None or purge_after is None:
        return False
    safe_horizon = max(
        retain_until,
        purge_after,
        updated_at + timedelta(seconds=_operation_fence_retention_seconds()),
    )
    key_ring_horizon = _lifecycle_timestamp(payload, "key_ring_retain_until")
    if key_ring_horizon is not None:
        safe_horizon = max(safe_horizon, key_ring_horizon)
    return safe_horizon <= current_time


def _remove_expired_purged_fence(state_path: Path, current_time: datetime) -> bool:
    try:
        observed = json.loads(state_path.read_text(encoding="utf-8"))
        if not _purged_fence_is_expired(observed, current_time):
            return False
        operation_digest = str(observed.get("operation_digest") or "").strip()
        digest_lock = (
            state_path.parent / f".{operation_digest}.lock"
            if len(operation_digest) == 64
            else state_path.with_suffix(".lock")
        )
        siblings = [state_path]
        if operation_digest:
            siblings = []
            for candidate in state_path.parent.glob("*.json"):
                if candidate.name.startswith(".key-canary-"):
                    continue
                try:
                    candidate_payload = json.loads(
                        candidate.read_text(encoding="utf-8")
                    )
                except (OSError, json.JSONDecodeError):
                    continue
                if candidate_payload.get("operation_digest") == operation_digest:
                    siblings.append(candidate)
                    if len(siblings) > 64:
                        return False
        lock_paths = sorted(
            {digest_lock, *(candidate.with_suffix(".lock") for candidate in siblings)},
            key=lambda path: path.name,
        )
        with ExitStack() as stack:
            for lock_path in lock_paths:
                stack.enter_context(_file_lock(lock_path))
            for candidate in siblings:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
                if not _purged_fence_is_expired(payload, current_time):
                    return False
            for candidate in siblings:
                candidate.unlink(missing_ok=True)
    except (
        OSError,
        ValueError,
        TypeError,
        json.JSONDecodeError,
        OperationStoreError,
    ):
        return False
    return not state_path.exists()


def _remove_operation_session_directory(root: Path, directory: Path) -> None:
    if directory.parent.resolve() != root.resolve():
        raise OperationStoreError("Operation session cleanup path không hợp lệ")
    if directory.is_symlink():
        directory.unlink(missing_ok=True)
        return
    shutil.rmtree(directory)


def _coordinated_remove_expired_directory(root: Path, directory: Path) -> bool:
    session_id = directory.name
    marker = directory / ".creating.json"
    if marker.is_file():
        try:
            session_id = str(
                json.loads(marker.read_text(encoding="utf-8")).get("session_id") or ""
            ).strip()
        except (OSError, json.JSONDecodeError):
            return False
    if not session_id or any(
        not (character.isalnum() or character in {"-", "_"})
        for character in session_id
    ):
        with _OPERATION_SESSION_DIRECTORY_LOCK:
            _remove_operation_session_directory(root, directory)
        return not directory.exists()

    lifecycle_root = root.parent / f".{root.name}-lifecycle"
    lifecycle_root.mkdir(parents=True, exist_ok=True)
    lifecycle_paths = _operation_fence_state_paths(lifecycle_root, session_id)
    with OperationStore._locks_guard:
        thread_lock = OperationStore._locks.setdefault(session_id, threading.RLock())
    with thread_lock:
        with _operation_fence_locks(lifecycle_root, session_id):
            observed: dict[str, Any] | None = None
            for key_id, lifecycle_path in lifecycle_paths:
                if not lifecycle_path.is_file():
                    continue
                lifecycle = _upgrade_lifecycle_payload(
                    _read_lifecycle_payload(lifecycle_path, expected_schema=2),
                    session_id,
                    key_id,
                )
                observed = (
                    lifecycle
                    if observed is None
                    else _merged_lifecycle_payload(
                        observed,
                        lifecycle,
                        session_id=session_id,
                    )
                )
            purging = _operation_fence_payload(
                "purging",
                datetime.now(timezone.utc),
                session_id=session_id,
            )
            if observed is not None:
                purging = _merged_lifecycle_payload(
                    observed,
                    purging,
                    session_id=session_id,
                )
            for _key_id, lifecycle_path in lifecycle_paths:
                OperationStore._atomic_write(lifecycle_path, purging)
            with _OPERATION_SESSION_DIRECTORY_LOCK:
                if directory.exists() or directory.is_symlink():
                    _remove_operation_session_directory(root, directory)
            if directory.exists() or directory.is_symlink():
                return False
            purged = _merged_lifecycle_payload(
                purging,
                _operation_fence_payload(
                    "purged",
                    datetime.now(timezone.utc),
                    session_id=session_id,
                ),
                session_id=session_id,
            )
            for _key_id, lifecycle_path in lifecycle_paths:
                OperationStore._atomic_write(lifecycle_path, purged)
            return True


def _state_hash(
    table_payload: dict[str, Any],
    overlays: dict[str, Any],
    context: dict[str, Any] | None = None,
) -> str:
    payload = {"table": table_payload, "overlays": overlays, "context": context or {}}
    encoded = json.dumps(
        _json_safe(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def _validate_owner_binding(
    owner_scope: str, user_id: str | None, workspace_id: str | None
) -> None:
    if not owner_scope or ":" not in owner_scope:
        raise OperationStoreError("Owner scope không hợp lệ")
    prefix, identifier = owner_scope.split(":", 1)
    if not identifier:
        raise OperationStoreError("Owner scope không hợp lệ")
    if prefix == "user" and identifier == str(user_id or "") and not workspace_id:
        return
    if prefix == "workspace" and identifier == str(workspace_id or ""):
        return
    if prefix == "local" and not user_id and not workspace_id:
        return
    raise OperationStoreError("Owner scope không khớp identity của phiên")


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _ttl_seconds() -> int:
    try:
        return max(60, int(os.getenv("OPERATION_SESSION_TTL_SECONDS", "3600")))
    except ValueError:
        return 3600
