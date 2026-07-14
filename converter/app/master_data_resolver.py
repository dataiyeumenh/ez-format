from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from app.master_data import normalize_code, normalize_name, normalize_tax_code


@dataclass
class MasterDataResolution:
    catalog_type: str
    field: str
    raw_value: str
    status: str
    match_method: str
    target_code: str | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)
    affected_rows: int = 1
    required: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "catalog_type": self.catalog_type,
            "field": self.field,
            "raw_value": self.raw_value,
            "status": self.status,
            "match_method": self.match_method,
            "target_code": self.target_code,
            "candidates": self.candidates,
            "affected_rows": self.affected_rows,
            "required": self.required,
        }


@dataclass
class MasterDataResolveResult:
    rows: list[dict[str, Any]]
    resolutions: list[MasterDataResolution]


def resolve_master_data(
    rows: list[dict[str, Any]],
    context: dict[str, Any] | None,
    *,
    source_system: str = "default",
) -> MasterDataResolveResult:
    output_rows = deepcopy(rows)
    catalogs = (context or {}).get("catalogs") or {}
    grouped: dict[tuple[str, str, str], list[int]] = {}

    for row_index, row in enumerate(output_rows):
        for header, value in row.items():
            catalog_type = catalog_type_for_field(header)
            raw_value = _text(value)
            if not catalog_type or not raw_value:
                continue
            key = (catalog_type, header, raw_value)
            grouped.setdefault(key, []).append(row_index)

    resolutions: list[MasterDataResolution] = []
    for (catalog_type, header, raw_value), row_indexes in grouped.items():
        resolution = _resolve_value(
            catalog_type,
            header,
            raw_value,
            catalogs.get(catalog_type),
            required="(*)" in header,
            source_system=source_system,
        )
        resolution.affected_rows = len(row_indexes)
        resolutions.append(resolution)
        if resolution.status == "verified" and resolution.target_code:
            for row_index in row_indexes:
                output_rows[row_index][header] = resolution.target_code

    return MasterDataResolveResult(rows=output_rows, resolutions=resolutions)


def catalog_type_for_field(header: str) -> str | None:
    normalized = normalize_name(header)
    if normalized.startswith("tk ") or normalized.startswith("tai khoan "):
        return "account"
    if "ma nha cung cap" in normalized or normalized == "ma ncc":
        return "supplier"
    if "ma khach hang" in normalized or normalized == "ma kh":
        return "customer"
    if "ma hang" in normalized or "ma vthh" in normalized or "ma vat tu" in normalized:
        return "item"
    if "ma kho" in normalized:
        return "warehouse"
    if normalized in {"dvt", "don vi tinh", "ma don vi tinh"}:
        return "unit"
    if "nhan vien mua hang" in normalized or normalized in {"ma nhan vien", "ma nv"}:
        return "employee"
    if normalized in {"so tai khoan ngan hang", "tai khoan ngan hang"}:
        return "bank_account"
    return None


def _resolve_value(
    catalog_type: str,
    header: str,
    raw_value: str,
    catalog: dict[str, Any] | None,
    *,
    required: bool,
    source_system: str,
) -> MasterDataResolution:
    if not catalog:
        return MasterDataResolution(
            catalog_type=catalog_type,
            field=header,
            raw_value=raw_value,
            status="not_checked",
            match_method="catalog_unavailable",
            required=required,
        )

    entries = [item for item in catalog.get("entries", []) if item.get("active", True)]
    aliases = catalog.get("aliases", [])
    normalized_code = normalize_code(raw_value)
    exact = [item for item in entries if item.get("normalizedCode") == normalized_code]
    if len(exact) == 1:
        return _verified(catalog_type, header, raw_value, exact[0], "exact_code", required)
    if len(exact) > 1:
        return _conflict(catalog_type, header, raw_value, exact, "duplicate_code", required)

    normalized_raw_name = normalize_name(raw_value)
    matching_aliases = [
        item
        for item in aliases
        if item.get("normalizedRawValue") == normalized_raw_name
        and str(item.get("sourceSystem") or "default") in {source_system, "default"}
    ]
    alias = next(
        (
            item
            for item in matching_aliases
            if str(item.get("sourceSystem") or "default") == source_system
        ),
        matching_aliases[0] if matching_aliases else None,
    )
    if alias:
        target = next(
            (
                item
                for item in entries
                if item.get("normalizedCode") == alias.get("normalizedTargetCode")
            ),
            None,
        )
        if target:
            return _verified(
                catalog_type, header, raw_value, target, "confirmed_alias", required
            )

    if catalog_type in {"supplier", "customer", "employee"}:
        normalized_tax = normalize_tax_code(raw_value)
        by_tax = [
            item
            for item in entries
            if normalized_tax and item.get("normalizedTaxCode") == normalized_tax
        ]
        if len(by_tax) == 1:
            return _verified(catalog_type, header, raw_value, by_tax[0], "exact_tax_code", required)
        if len(by_tax) > 1:
            return _conflict(catalog_type, header, raw_value, by_tax, "duplicate_tax_code", required)

    if catalog_type == "account":
        return MasterDataResolution(
            catalog_type=catalog_type,
            field=header,
            raw_value=raw_value,
            status="missing",
            match_method="exact_only",
            required=required,
        )

    exact_names = [
        item for item in entries if item.get("normalizedName") == normalized_raw_name
    ]
    if exact_names:
        return MasterDataResolution(
            catalog_type=catalog_type,
            field=header,
            raw_value=raw_value,
            status="suggested" if len(exact_names) == 1 else "conflict",
            match_method="exact_name",
            candidates=[_candidate(item, 1.0) for item in exact_names[:5]],
            required=required,
        )

    candidates = _name_candidates(normalized_raw_name, entries)
    if candidates:
        return MasterDataResolution(
            catalog_type=catalog_type,
            field=header,
            raw_value=raw_value,
            status="suggested",
            match_method="name_similarity",
            candidates=candidates,
            required=required,
        )

    return MasterDataResolution(
        catalog_type=catalog_type,
        field=header,
        raw_value=raw_value,
        status="missing",
        match_method="not_found",
        required=required,
    )


def _verified(
    catalog_type: str,
    header: str,
    raw_value: str,
    entry: dict[str, Any],
    method: str,
    required: bool,
) -> MasterDataResolution:
    return MasterDataResolution(
        catalog_type=catalog_type,
        field=header,
        raw_value=raw_value,
        status="verified",
        match_method=method,
        target_code=entry.get("code"),
        candidates=[_candidate(entry, 1.0)],
        required=required,
    )


def _conflict(
    catalog_type: str,
    header: str,
    raw_value: str,
    entries: list[dict[str, Any]],
    method: str,
    required: bool,
) -> MasterDataResolution:
    return MasterDataResolution(
        catalog_type=catalog_type,
        field=header,
        raw_value=raw_value,
        status="conflict",
        match_method=method,
        candidates=[_candidate(item, 1.0) for item in entries[:5]],
        required=required,
    )


def _name_candidates(
    normalized_raw_name: str, entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not normalized_raw_name:
        return []
    scored: list[tuple[float, dict[str, Any]]] = []
    for entry in entries:
        candidate_name = entry.get("normalizedName") or ""
        if not candidate_name:
            continue
        score = SequenceMatcher(None, normalized_raw_name, candidate_name).ratio()
        if score >= 0.78:
            scored.append((score, entry))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [_candidate(entry, score) for score, entry in scored[:3]]


def _candidate(entry: dict[str, Any], score: float) -> dict[str, Any]:
    return {
        "code": entry.get("code") or "",
        "name": entry.get("name") or "",
        "tax_code": entry.get("taxCode") or "",
        "score": round(score, 4),
    }


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
