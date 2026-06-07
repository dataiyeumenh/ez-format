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
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_mapping_profiles_signature
                    ON mapping_profiles(target_template_id, source_signature_hash);

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

    def find_by_signature(
        self, *, target_template_id: str, source_signature_hash: str
    ) -> MappingProfile | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM mapping_profiles
                WHERE target_template_id = ? AND source_signature_hash = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (target_template_id, source_signature_hash),
            ).fetchone()
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
    ) -> MappingProfile:
        existing = self.find_by_signature(
            target_template_id=target_template_id,
            source_signature_hash=source_signature_hash,
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
                        id, name, target_template_id, source_signature_hash,
                        source_headers_json, sheet_name, header_row, mapping_json,
                        defaults_json, formulas_json, confidence, usage_count,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        profile_id,
                        name,
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
        return self.get_profile(profile_id)

    def get_profile(self, profile_id: str) -> MappingProfile:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM mapping_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        if not row:
            raise KeyError(f"Mapping profile not found: {profile_id}")
        return self._row_to_profile(row)

    def mark_used(self, profile_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE mapping_profiles
                SET usage_count = usage_count + 1, updated_at = ?
                WHERE id = ?
                """,
                (utc_now(), profile_id),
            )

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
        )
