from __future__ import annotations

import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.conversion_types import BACKEND_ROOT


def db_path() -> Path:
    configured = os.getenv("MAPPING_DB_PATH")
    if configured:
        return Path(configured)
    return BACKEND_ROOT / "data" / "mapping_profiles.sqlite"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_mapping_owner_scope() -> str:
    return os.getenv("LOCAL_MAPPING_OWNER_SCOPE", "local:default").strip() or "local:default"


def resolve_owner_scope(
    owner_scope: str | None = None,
    *,
    workspace_id: str = "",
) -> str:
    if owner_scope is not None:
        normalized = str(owner_scope).strip()
        if not normalized:
            raise ValueError("Mapping profile owner_scope must not be empty")
        return normalized
    normalized_workspace = str(workspace_id or "").strip()
    if normalized_workspace:
        return f"workspace:{normalized_workspace}"
    return local_mapping_owner_scope()


@dataclass(frozen=True)
class MappingProfile:
    id: str
    name: str
    target_template_id: str
    source_signature_hash: str
    source_headers: list[str]
    sheet_name: str
    header_row: int
    mapping: dict[str, Any]
    defaults: dict[str, Any]
    formulas: dict[str, Any]
    confidence: float
    usage_count: int
    owner_scope: str = ""
    workspace_id: str = ""


class ProfileStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS mapping_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    target_template_id TEXT NOT NULL,
                    source_signature_hash TEXT NOT NULL,
                    source_headers_json TEXT NOT NULL,
                    sheet_name TEXT NOT NULL,
                    header_row INTEGER NOT NULL,
                    mapping_json TEXT NOT NULL,
                    defaults_json TEXT NOT NULL,
                    formulas_json TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    usage_count INTEGER NOT NULL DEFAULT 0,
                    owner_scope TEXT NOT NULL CHECK (length(trim(owner_scope)) > 0),
                    workspace_id TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversion_runs (
                    id TEXT PRIMARY KEY,
                    upload_filename TEXT NOT NULL,
                    target_template_id TEXT NOT NULL,
                    profile_id TEXT,
                    mapping_source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    issues_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS mapping_corrections (
                    id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL,
                    before_json TEXT NOT NULL,
                    after_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(mapping_profiles)").fetchall()
            }
            if "workspace_id" not in columns:
                connection.execute(
                    "ALTER TABLE mapping_profiles ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''"
                )
            owner_scope_added = "owner_scope" not in columns
            if owner_scope_added:
                connection.execute(
                    "ALTER TABLE mapping_profiles ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'local:legacy'"
                )
            if owner_scope_added:
                connection.execute(
                    """
                    UPDATE mapping_profiles
                    SET owner_scope = CASE
                        WHEN length(trim(workspace_id)) > 0
                            THEN 'workspace:' || trim(workspace_id)
                        ELSE 'local:legacy'
                    END
                    """
                )
            else:
                connection.execute(
                    """
                    UPDATE mapping_profiles
                    SET owner_scope = CASE
                        WHEN length(trim(workspace_id)) > 0
                            THEN 'workspace:' || trim(workspace_id)
                        ELSE 'local:legacy'
                    END
                    WHERE length(trim(owner_scope)) = 0
                    """
                )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_mapping_profiles_owner_signature
                ON mapping_profiles(owner_scope, target_template_id, source_signature_hash)
                """
            )
            connection.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS mapping_profiles_owner_scope_insert
                BEFORE INSERT ON mapping_profiles
                WHEN length(trim(NEW.owner_scope)) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'mapping_profiles.owner_scope must not be empty');
                END;

                CREATE TRIGGER IF NOT EXISTS mapping_profiles_owner_scope_update
                BEFORE UPDATE OF owner_scope ON mapping_profiles
                WHEN length(trim(NEW.owner_scope)) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'mapping_profiles.owner_scope must not be empty');
                END;
                """
            )

    def find_by_signature(
        self,
        *,
        target_template_id: str,
        source_signature_hash: str,
        owner_scope: str | None = None,
        workspace_id: str = "",
    ) -> MappingProfile | None:
        resolved_owner_scope = resolve_owner_scope(
            owner_scope,
            workspace_id=workspace_id,
        )
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM mapping_profiles
                WHERE owner_scope = ? AND target_template_id = ? AND source_signature_hash = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (resolved_owner_scope, target_template_id, source_signature_hash),
            ).fetchone()
            if row is None and resolved_owner_scope == "local:default":
                row = self._claim_legacy_profile_by_signature(
                    connection,
                    target_template_id=target_template_id,
                    source_signature_hash=source_signature_hash,
                )
        return self._row_to_profile(row) if row else None

    def save_profile(
        self,
        *,
        name: str,
        target_template_id: str,
        source_signature_hash: str,
        source_headers: list[str],
        sheet_name: str,
        header_row: int,
        mapping: dict[str, Any],
        defaults: dict[str, Any],
        formulas: dict[str, Any],
        confidence: float,
        previous: dict[str, Any] | None = None,
        owner_scope: str | None = None,
        workspace_id: str = "",
    ) -> MappingProfile:
        resolved_owner_scope = resolve_owner_scope(
            owner_scope,
            workspace_id=workspace_id,
        )
        existing = self.find_by_signature(
            target_template_id=target_template_id,
            source_signature_hash=source_signature_hash,
            owner_scope=resolved_owner_scope,
        )
        now = utc_now()
        profile_id = existing.id if existing else str(uuid.uuid4())
        with self._connect() as connection:
            if existing:
                connection.execute(
                    """
                    UPDATE mapping_profiles
                    SET name = ?, source_headers_json = ?, sheet_name = ?, header_row = ?,
                        mapping_json = ?, defaults_json = ?, formulas_json = ?,
                        confidence = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        json.dumps(source_headers, ensure_ascii=False),
                        sheet_name,
                        header_row,
                        json.dumps(mapping, ensure_ascii=False),
                        json.dumps(defaults, ensure_ascii=False),
                        json.dumps(formulas, ensure_ascii=False),
                        confidence,
                        now,
                        profile_id,
                    ),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO mapping_profiles (
                        id, name, owner_scope, workspace_id, target_template_id, source_signature_hash,
                        source_headers_json, sheet_name, header_row, mapping_json,
                        defaults_json, formulas_json, confidence, usage_count,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        profile_id,
                        name,
                        resolved_owner_scope,
                        workspace_id,
                        target_template_id,
                        source_signature_hash,
                        json.dumps(source_headers, ensure_ascii=False),
                        sheet_name,
                        header_row,
                        json.dumps(mapping, ensure_ascii=False),
                        json.dumps(defaults, ensure_ascii=False),
                        json.dumps(formulas, ensure_ascii=False),
                        confidence,
                        now,
                        now,
                    ),
                )
            if previous is not None:
                connection.execute(
                    """
                    INSERT INTO mapping_corrections (
                        id, profile_id, before_json, after_json, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        profile_id,
                        json.dumps(previous, ensure_ascii=False),
                        json.dumps(
                            {
                                "mapping": mapping,
                                "defaults": defaults,
                                "formulas": formulas,
                            },
                            ensure_ascii=False,
                        ),
                        now,
                    ),
                )
        return self.get_profile(profile_id, owner_scope=resolved_owner_scope)

    def get_profile(
        self,
        profile_id: str,
        *,
        owner_scope: str | None = None,
        workspace_id: str = "",
    ) -> MappingProfile:
        resolved_owner_scope = resolve_owner_scope(
            owner_scope,
            workspace_id=workspace_id,
        )
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = ?",
                (profile_id, resolved_owner_scope),
            ).fetchone()
            if row is None and resolved_owner_scope == "local:default":
                row = self._claim_legacy_profile_by_id(connection, profile_id)
        if not row:
            raise KeyError(f"Mapping profile not found: {profile_id}")
        return self._row_to_profile(row)

    def mark_used(
        self,
        profile_id: str,
        *,
        owner_scope: str | None = None,
        workspace_id: str = "",
    ) -> None:
        resolved_owner_scope = resolve_owner_scope(
            owner_scope,
            workspace_id=workspace_id,
        )
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE mapping_profiles
                SET usage_count = usage_count + 1, updated_at = ?
                WHERE id = ? AND owner_scope = ?
                """,
                (utc_now(), profile_id, resolved_owner_scope),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"Mapping profile not found: {profile_id}")

    @staticmethod
    def _claim_legacy_profile_by_signature(
        connection: sqlite3.Connection,
        *,
        target_template_id: str,
        source_signature_hash: str,
    ) -> sqlite3.Row | None:
        legacy = connection.execute(
            """
            SELECT id FROM mapping_profiles
            WHERE owner_scope = 'local:legacy'
              AND target_template_id = ?
              AND source_signature_hash = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (target_template_id, source_signature_hash),
        ).fetchone()
        if legacy is None:
            return None
        connection.execute(
            """
            UPDATE mapping_profiles
            SET owner_scope = 'local:default'
            WHERE id = ? AND owner_scope = 'local:legacy'
            """,
            (legacy["id"],),
        )
        return connection.execute(
            "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = 'local:default'",
            (legacy["id"],),
        ).fetchone()

    @staticmethod
    def _claim_legacy_profile_by_id(
        connection: sqlite3.Connection,
        profile_id: str,
    ) -> sqlite3.Row | None:
        connection.execute(
            """
            UPDATE mapping_profiles
            SET owner_scope = 'local:default'
            WHERE id = ? AND owner_scope = 'local:legacy'
            """,
            (profile_id,),
        )
        return connection.execute(
            "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = 'local:default'",
            (profile_id,),
        ).fetchone()

    def record_run(
        self,
        *,
        run_id: str,
        upload_filename: str,
        target_template_id: str,
        profile_id: str | None,
        mapping_source: str,
        status: str,
        issues: list[dict[str, Any]],
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO conversion_runs (
                    id, upload_filename, target_template_id, profile_id,
                    mapping_source, status, issues_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    upload_filename,
                    target_template_id,
                    profile_id,
                    mapping_source,
                    status,
                    json.dumps(issues, ensure_ascii=False),
                    utc_now(),
                ),
            )

    @staticmethod
    def _row_to_profile(row: sqlite3.Row) -> MappingProfile:
        return MappingProfile(
            id=row["id"],
            name=row["name"],
            target_template_id=row["target_template_id"],
            source_signature_hash=row["source_signature_hash"],
            source_headers=json.loads(row["source_headers_json"]),
            sheet_name=row["sheet_name"],
            header_row=int(row["header_row"]),
            mapping=json.loads(row["mapping_json"]),
            defaults=json.loads(row["defaults_json"]),
            formulas=json.loads(row["formulas_json"]),
            confidence=float(row["confidence"]),
            usage_count=int(row["usage_count"]),
            owner_scope=str(row["owner_scope"] or ""),
            workspace_id=str(row["workspace_id"] or ""),
        )
