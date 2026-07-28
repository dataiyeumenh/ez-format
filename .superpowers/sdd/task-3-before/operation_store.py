from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator

from app.conversion_types import BACKEND_ROOT
from app.excel_io import InputTable
from app.operation_models import DerivedRevision, NormalizedSession


class OperationStoreError(ValueError):
    pass


class OperationStoreConflictError(OperationStoreError):
    pass


class OperationStoreExpiredError(OperationStoreError):
    pass


def unauthenticated_local_operations_enabled() -> bool:
    return os.getenv(
        "ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false"
    ).strip().lower() in {"1", "true", "yes"}


class OperationStore:
    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, root: Path | None = None) -> None:
        configured = os.getenv("OPERATION_SESSION_DIR", "").strip()
        self.root = root or (
            Path(configured)
            if configured
            else BACKEND_ROOT / ".artifacts" / "operation-sessions"
        )
        self.root.mkdir(parents=True, exist_ok=True)

    def create_session(
        self,
        *,
        upload_id: str,
        owner_scope: str,
        user_id: str | None,
        workspace_id: str | None,
        target_template_id: str,
        target_template_version: str,
        source_signature: dict[str, Any],
        table: InputTable,
        raw_sha256: str,
        ttl_seconds: int | None = None,
        initial_context: dict[str, Any] | None = None,
    ) -> NormalizedSession:
        _validate_owner_binding(owner_scope, user_id, workspace_id)
        session_id = str(uuid.uuid4())
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
        base_context = {
            "target_template_id": target_template_id,
            **_json_safe(initial_context or {}),
        }
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
        directory = self._directory(session_id)
        directory.mkdir(parents=True, exist_ok=False)
        self._atomic_write(directory / "table.json", table_payload)
        self._save_session(session)
        return session

    def load_session(self, session_id: str) -> NormalizedSession:
        path = self._directory(session_id) / "session.json"
        if not path.exists():
            raise OperationStoreError("Phiên chuyển đổi không tồn tại")
        try:
            session = NormalizedSession.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise OperationStoreError("Dữ liệu phiên chuyển đổi không hợp lệ") from exc
        if session.expires_at <= datetime.now(timezone.utc):
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
        for item in self._read_table(session_id)["rows"]:
            values = dict(item["values"])
            values.update(target.overlays.get(str(item["row_id"]), {}))
            output.append({"row_id": str(item["row_id"]), "values": values})
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

    def _read_table(self, session_id: str) -> dict[str, Any]:
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

    def _save_session(self, session: NormalizedSession) -> None:
        payload = session.model_dump(mode="json")
        self._atomic_write(self._directory(session.session_id) / "session.json", payload)

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
        cls = type(self)
        with cls._locks_guard:
            thread_lock = cls._locks.setdefault(session_id, threading.RLock())
        with thread_lock:
            lock_path = self._directory(session_id) / ".session.lock"
            with _file_lock(lock_path):
                yield

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
