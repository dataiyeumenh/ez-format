from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator

from app.conversion_types import BACKEND_ROOT
from app.excel_io import InputTable
from app.internal_auth import unauthenticated_local_operations_enabled as _local_mode_enabled
from app.master_data_client import ConversionContextError, verify_conversion_context_token
from app.operation_models import DerivedRevision, NormalizedSession
from app.operation_store_client import NodeOperationStoreClient, OperationStoreClientError


STUDENT_METADATA_STATE_CONTRACT = "student_metadata_v1"
DEFAULT_OPERATION_SESSION_CLEANUP_BATCH_SIZE = 100


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
    if not session_root.is_dir():
        return []
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
    inspected = 0
    for directory in sorted(session_root.iterdir(), key=lambda path: path.name):
        if inspected >= limit:
            break
        if not directory.is_dir() and not directory.is_symlink():
            continue
        inspected += 1
        expires_at = _local_session_expiry(directory)
        if expires_at is not None and expires_at > current_time:
            continue
        try:
            _remove_operation_session_directory(session_root, directory)
        except OSError:
            continue
        if not directory.exists():
            deleted.append(directory.name)
    return deleted



class OperationStore:
    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

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
        self._remote_client = remote_client
        self._remote_run_id = str(conversion_run_id or "").strip()
        self._remote_payloads: dict[str, dict[str, Any]] = {}
        self._remote_storage_revisions: dict[str, int] = {}
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
        if state_contract:
            self._state_contracts[session_id] = state_contract
        if self._remote_client is None or state_contract == STUDENT_METADATA_STATE_CONTRACT:
            directory = self._directory(session_id)
            directory.mkdir(parents=True, exist_ok=False)
            self._atomic_write(directory / "table.json", table_payload)
        self._save_session(session, table_payload)
        return session

    def load_session(self, session_id: str) -> NormalizedSession:
        if self._remote_client is not None:
            if self._state_contracts.get(session_id) == STUDENT_METADATA_STATE_CONTRACT:
                cached = self._remote_payloads.get(session_id)
                if cached is not None:
                    session = cached["session"]
                    if session.expires_at <= datetime.now(timezone.utc):
                        self._purge_local_state(session_id)
                        raise OperationStoreExpiredError("Phiên chuyển đổi đã hết hạn")
                    return session
            try:
                session, _ = self._load_remote_state(session_id)
                return session
            except OperationStoreExpiredError:
                self._purge_local_state(session_id)
                raise
            except OperationStoreClientError as exc:
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
            self._purge_local_state(session_id)
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
        if self._state_contracts.get(session_id) == STUDENT_METADATA_STATE_CONTRACT:
            return self._read_local_table(session_id)
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
            if (
                self._state_contracts.get(session.session_id)
                == STUDENT_METADATA_STATE_CONTRACT
            ):
                self._atomic_write(
                    self._directory(session.session_id) / "session.json",
                    session.model_dump(mode="json"),
                )
            return
        payload = session.model_dump(mode="json")
        self._atomic_write(self._directory(session.session_id) / "session.json", payload)

    def _load_remote_state(
        self, session_id: str
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
        session, table_payload = self._validate_remote_state(session_id, state)
        metadata = result.get("session") if isinstance(result, dict) else None
        if isinstance(metadata, dict):
            stored_revision = metadata.get("revision")
            if isinstance(stored_revision, int) and stored_revision >= 1:
                self._remote_storage_revisions[session_id] = stored_revision
        self._remote_payloads[session_id] = {"session": session, "table": table_payload}
        return session, table_payload

    def _save_remote_state(
        self, session: NormalizedSession, table_payload: dict[str, Any]
    ) -> None:
        run_id = self._remote_run_id or self._run_id_from_session(session)
        if not run_id:
            raise OperationStoreError("Conversion run binding là bắt buộc")
        self._remote_run_id = run_id
        storage_revision = self._remote_storage_revisions.get(session.session_id, 0) + 1
        state = (
            self._student_metadata_remote_state(session, table_payload)
            if self._state_contracts.get(session.session_id)
            == STUDENT_METADATA_STATE_CONTRACT
            else {
                "schema_version": 1,
                "session": session.model_dump(mode="json"),
                "table": table_payload,
            }
        )
        try:
            result = self._remote_client.put_state(
                session_id=session.session_id,
                run_id=run_id,
                revision=storage_revision,
                state=state,
                expires_at=session.expires_at,
            )
        except OperationStoreClientError as exc:
            self._raise_remote_error(exc)
        except Exception as exc:
            raise OperationStoreError("Không lưu được session state vào Node") from exc
        metadata = result.get("session") if isinstance(result, dict) else None
        remote_revision = metadata.get("revision") if isinstance(metadata, dict) else None
        self._remote_storage_revisions[session.session_id] = (
            remote_revision if isinstance(remote_revision, int) and remote_revision >= 1 else storage_revision
        )
        self._remote_payloads[session.session_id] = {"session": session, "table": table_payload}

    @staticmethod
    def _student_metadata_remote_state(
        session: NormalizedSession, table_payload: dict[str, Any]
    ) -> dict[str, Any]:
        raw_session = session.model_dump(mode="json")
        signature = session.source_signature if isinstance(session.source_signature, dict) else {}
        session_payload = {
            key: raw_session[key]
            for key in (
                "session_id",
                "upload_id",
                "user_id",
                "workspace_id",
                "owner_scope",
                "target_template_id",
                "target_template_version",
                "primary_table_id",
                "active_revision",
                "state_hash",
                "raw_sha256",
                "created_at",
                "expires_at",
            )
        }
        session_payload["source_signature"] = {
            "hash": str(signature.get("hash") or ""),
            "row_count": len(table_payload.get("rows") or []),
            "column_count": len(table_payload.get("headers") or []),
        }
        session_payload["revisions"] = [
            OperationStore._student_metadata_revision(revision)
            for revision in raw_session.get("revisions") or []
            if isinstance(revision, dict)
        ]
        return {
            "schema_version": 1,
            "contract": STUDENT_METADATA_STATE_CONTRACT,
            "session": session_payload,
            "table_metadata": {
                "row_count": len(table_payload.get("rows") or []),
                "column_count": len(table_payload.get("headers") or []),
                "header_row_index": int(table_payload.get("header_row_index") or 0),
                "has_sheet_name": bool(table_payload.get("sheet_name")),
            },
        }

    @staticmethod
    def _student_metadata_revision(revision: dict[str, Any]) -> dict[str, Any]:
        context = revision.get("context")
        payload = {
            key: revision.get(key)
            for key in (
                "revision",
                "parent_revision",
                "patch_set_id",
                "state_hash",
                "created_by",
                "created_at",
            )
        }
        payload["context"] = {
            key: context[key]
            for key in ("target_template_id", "conversion_run_id")
            if isinstance(context, dict) and context.get(key) is not None
        }
        return payload

    @staticmethod
    def _run_id_from_session(session: NormalizedSession) -> str:
        if not session.revisions:
            return ""
        return str(session.revisions[0].context.get("conversion_run_id") or "").strip()

    def _validate_remote_state(
        self, session_id: str, state: dict[str, Any]
    ) -> tuple[NormalizedSession, dict[str, Any]]:
        raw_session = state.get("session")
        table_payload = state.get("table")
        contract = state.get("contract")
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
        if contract == STUDENT_METADATA_STATE_CONTRACT:
            self._state_contracts[session_id] = STUDENT_METADATA_STATE_CONTRACT
            table_metadata = state.get("table_metadata")
            if not isinstance(table_metadata, dict):
                raise OperationStoreError("Student table metadata từ Node không hợp lệ")
            session = self._load_local_session(session_id)
            table_payload = self._read_local_table(session_id)
            bound_fields = (
                "session_id",
                "upload_id",
                "user_id",
                "workspace_id",
                "owner_scope",
                "target_template_id",
                "target_template_version",
                "active_revision",
                "state_hash",
                "raw_sha256",
                "expires_at",
            )
            if any(
                getattr(session, field) != getattr(remote_session, field)
                for field in bound_fields
            ):
                raise OperationStoreError("Student session metadata binding không hợp lệ")
            try:
                remote_row_count = int(table_metadata["row_count"])
                remote_column_count = int(table_metadata["column_count"])
                remote_header_row_index = int(table_metadata["header_row_index"])
            except (KeyError, TypeError, ValueError) as exc:
                raise OperationStoreError(
                    "Student table metadata binding không hợp lệ"
                ) from exc
            if (
                remote_row_count != len(table_payload.get("rows") or [])
                or remote_column_count != len(table_payload.get("headers") or [])
                or remote_header_row_index
                != int(table_payload.get("header_row_index") or 0)
                or bool(table_metadata.get("has_sheet_name"))
                != bool(table_payload.get("sheet_name"))
            ):
                raise OperationStoreError("Student table metadata binding không hợp lệ")
        else:
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

    def _purge_local_state(self, session_id: str) -> None:
        self._remote_payloads.pop(session_id, None)
        self._remote_storage_revisions.pop(session_id, None)
        self._state_contracts.pop(session_id, None)
        directory = self._directory(session_id)
        if directory.exists() or directory.is_symlink():
            _remove_operation_session_directory(self.root, directory)

    @staticmethod
    def _raise_remote_error(exc: OperationStoreClientError) -> None:
        if exc.status_code == 410:
            raise OperationStoreExpiredError("Phiên chuyển đổi đã hết hạn") from exc
        if exc.status_code == 409:
            raise OperationStoreConflictError(str(exc)) from exc
        if exc.status_code in {401, 403}:
            raise ConversionContextError(str(exc), status_code=exc.status_code) from exc
        if exc.status_code == 404:
            raise OperationStoreError("Session not found") from exc
        raise OperationStoreError(str(exc)) from exc

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


def _local_session_expiry(directory: Path) -> datetime | None:
    path = directory / "session.json"
    if not path.is_file():
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


def _remove_operation_session_directory(root: Path, directory: Path) -> None:
    if directory.parent.resolve() != root.resolve():
        raise OperationStoreError("Operation session cleanup path không hợp lệ")
    if directory.is_symlink():
        directory.unlink(missing_ok=True)
        return
    shutil.rmtree(directory)


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
