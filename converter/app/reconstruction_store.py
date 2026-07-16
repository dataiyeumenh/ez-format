from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Protocol

from app.conversion_types import BACKEND_ROOT


class ReconstructionStoreError(ValueError):
    pass


class ReconstructionStoreConflictError(ReconstructionStoreError):
    pass


class ReconstructionStore(Protocol):
    def save(
        self,
        reconstruction_id: str,
        payload: dict[str, Any],
        *,
        expected_state_revision: int | None = None,
    ) -> None: ...
    def load(self, reconstruction_id: str) -> dict[str, Any]: ...
    def delete(self, reconstruction_id: str) -> None: ...


class FilesystemReconstructionStore:
    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, root: Path | None = None) -> None:
        configured = os.getenv("RECONSTRUCTION_STORE_DIR", "").strip()
        self.root = root or (
            Path(configured)
            if configured
            else BACKEND_ROOT / ".artifacts" / "reconstructions"
        )
        self.root.mkdir(parents=True, exist_ok=True)

    def save(
        self,
        reconstruction_id: str,
        payload: dict[str, Any],
        *,
        expected_state_revision: int | None = None,
    ) -> None:
        with self._lock(reconstruction_id):
            path = self._path(reconstruction_id)
            current_revision = 0
            if path.exists():
                try:
                    current_revision = int(
                        json.loads(path.read_text(encoding="utf-8")).get(
                            "state_revision", 0
                        )
                    )
                except (OSError, ValueError, json.JSONDecodeError):
                    current_revision = 0
            if (
                expected_state_revision is not None
                and current_revision != expected_state_revision
            ):
                raise ReconstructionStoreConflictError(
                    "Phiên tái tạo đã thay đổi bởi yêu cầu khác"
                )
            payload["state_revision"] = current_revision + 1
            payload.setdefault("expires_at", _expiry_timestamp())
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            temporary.replace(path)

    def load(self, reconstruction_id: str) -> dict[str, Any]:
        path = self._path(reconstruction_id)
        if not path.exists():
            raise ReconstructionStoreError("Phiên tái tạo không tồn tại hoặc đã hết hạn")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReconstructionStoreError("Dữ liệu phiên tái tạo không hợp lệ") from exc
        if float(payload.get("expires_at") or 0) <= time.time():
            path.unlink(missing_ok=True)
            raise ReconstructionStoreError("Phiên tái tạo đã hết hạn")
        return payload

    def delete(self, reconstruction_id: str) -> None:
        self._path(reconstruction_id).unlink(missing_ok=True)

    def _path(self, reconstruction_id: str) -> Path:
        safe_id = "".join(
            character
            for character in str(reconstruction_id)
            if character.isalnum() or character in {"-", "_"}
        )
        if not safe_id:
            raise ReconstructionStoreError("Reconstruction ID không hợp lệ")
        return self.root / f"{safe_id}.json"

    @classmethod
    def _lock(cls, reconstruction_id: str) -> threading.RLock:
        with cls._locks_guard:
            return cls._locks.setdefault(reconstruction_id, threading.RLock())


class RedisReconstructionStore:
    def __init__(self) -> None:
        try:
            import redis
        except ImportError as exc:
            raise ReconstructionStoreError(
                "RECONSTRUCTION_STORE_PROVIDER=redis yêu cầu package redis"
            ) from exc
        url, prefix = redis_connection_config()
        self.client = redis.Redis.from_url(url, decode_responses=True)
        self.prefix = prefix

    def save(
        self,
        reconstruction_id: str,
        payload: dict[str, Any],
        *,
        expected_state_revision: int | None = None,
    ) -> None:
        ttl = max(60, int(_ttl_hours() * 60 * 60))
        key = self._key(reconstruction_id)
        with self.client.pipeline() as pipe:
            while True:
                try:
                    pipe.watch(key)
                    raw = pipe.get(key)
                    current_revision = int(
                        json.loads(raw).get("state_revision", 0) if raw else 0
                    )
                    if (
                        expected_state_revision is not None
                        and current_revision != expected_state_revision
                    ):
                        raise ReconstructionStoreConflictError(
                            "Phiên tái tạo đã thay đổi bởi yêu cầu khác"
                        )
                    payload["state_revision"] = current_revision + 1
                    pipe.multi()
                    pipe.setex(
                        key,
                        ttl,
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    )
                    pipe.execute()
                    break
                except ReconstructionStoreConflictError:
                    raise
                except Exception as exc:
                    if exc.__class__.__name__ == "WatchError":
                        continue
                    raise

    def load(self, reconstruction_id: str) -> dict[str, Any]:
        raw = self.client.get(self._key(reconstruction_id))
        if not raw:
            raise ReconstructionStoreError("Phiên tái tạo không tồn tại hoặc đã hết hạn")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ReconstructionStoreError("Dữ liệu phiên tái tạo không hợp lệ") from exc

    def delete(self, reconstruction_id: str) -> None:
        self.client.delete(self._key(reconstruction_id))

    def _key(self, reconstruction_id: str) -> str:
        return f"{self.prefix}:{reconstruction_id}"


def get_reconstruction_store() -> ReconstructionStore:
    provider = os.getenv("RECONSTRUCTION_STORE_PROVIDER", "filesystem").strip().lower()
    if provider == "redis":
        return RedisReconstructionStore()
    if provider != "filesystem":
        raise ReconstructionStoreError(f"Store provider không hỗ trợ: {provider}")
    return FilesystemReconstructionStore()


def redis_connection_config() -> tuple[str, str]:
    url = os.getenv("RECONSTRUCTION_REDIS_URL", "").strip()
    if not url:
        raise ReconstructionStoreError("RECONSTRUCTION_REDIS_URL chưa được cấu hình")
    environment = str(
        os.getenv("RECONSTRUCTION_ENVIRONMENT")
        or os.getenv("NODE_ENV")
        or "development"
    ).strip().lower()
    if environment in {"production", "prod"} and not url.lower().startswith(
        "rediss://"
    ):
        raise ReconstructionStoreError(
            "Production reconstruction store bắt buộc dùng Redis TLS (rediss://)"
        )
    default_prefix = f"ezformat:{environment or 'development'}:reconstruction"
    prefix = os.getenv("RECONSTRUCTION_REDIS_PREFIX", default_prefix).strip()
    if not prefix or any(character.isspace() for character in prefix):
        raise ReconstructionStoreError("RECONSTRUCTION_REDIS_PREFIX không hợp lệ")
    return url, prefix


def _ttl_hours() -> float:
    try:
        return max(1.0, float(os.getenv("RECONSTRUCTION_STORE_TTL_HOURS", "24")))
    except ValueError:
        return 24.0


def _expiry_timestamp() -> float:
    return time.time() + _ttl_hours() * 60 * 60
