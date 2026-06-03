from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.conversion_types import CONVERSION_TYPES
from app.excel_io import InputTable
from app.field_detection import detect_columns
from app.normalization import normalize_header
from app.parsing import parse_date, parse_number


MappingValue = str | list[str]

NUMERIC_TARGET_HINTS = (
    "số lượng",
    "đơn giá",
    "thành tiền",
    "tiền chiết khấu",
    "tiền thuế",
    "tỷ giá",
    "đơn giá vốn",
    "tiền vốn",
)


BSN_SALES_DIRECT_MAPPING: dict[str, MappingValue] = {
    "Mã hóa đơn": "Số chứng từ (*)",
    "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
    "Mã khách hàng": "Mã khách hàng",
    "Tên khách hàng": "Tên khách hàng",
    "Mã hàng": "Mã hàng (*)",
    "Tên hàng": "Tên hàng",
    "ĐVT": "ĐVT",
    "Số lượng": "Số lượng",
    "Đơn giá": "Đơn giá",
    "Column1": "Tiền chiết khấu",
    "Lô": "Số lô",
    "Hạn sử dụng": "Hạn sử dụng",
}

BSN_SALES_BLOCKED_AUTO_TARGETS = {"Địa chỉ"}

BSN_SALES_FORMULAS = {
    "Số phiếu xuất": "XK_${Số chứng từ (*)}",
    "Diễn giải/Lý do nộp": "Bán hàng cho ${Tên khách hàng}",
    "Lý do xuất": "Xuất kho bán hàng cho ${Tên khách hàng}",
    "Thành tiền": "${Số lượng} * ${Đơn giá}",
}

BSN_SALES_DEFAULTS = {
    "Mã khách hàng": "KH_LE",
}


@dataclass(frozen=True)
class SourceSignature:
    sheet_name: str
    header_row: int
    row_count: int
    headers: list[str]
    hash: str


@dataclass(frozen=True)
class MappingSuggestion:
    source: str
    confidence: float
    mapping: dict[str, MappingValue]
    defaults: dict[str, Any]
    formulas: dict[str, str]
    warnings: list[str]
    profile_id: str | None = None

    def model_dump(self) -> dict[str, Any]:
        payload = {
            "source": self.source,
            "confidence": self.confidence,
            "mapping": self.mapping,
            "defaults": self.defaults,
            "formulas": self.formulas,
            "warnings": self.warnings,
        }
        if self.profile_id:
            payload["profile_id"] = self.profile_id
        return payload


def source_signature(table: InputTable) -> SourceSignature:
    normalized_headers = [normalize_header(header) for header in table.headers]
    payload = {
        "sheet_name": normalize_header(table.sheet_name or ""),
        "headers": normalized_headers,
    }
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return SourceSignature(
        sheet_name=table.sheet_name or "",
        header_row=table.header_row_index + 1,
        row_count=len(table.rows),
        headers=table.headers,
        hash=digest,
    )


def detect_target_template_id(table: InputTable, requested: str | None = None) -> str:
    if requested:
        return requested
    normalized = {normalize_header(header) for header in table.headers}
    if {"ma_hoa_don", "ten_khach_hang", "ma_hang"} & normalized:
        return "bsn_sales"
    if {"ma_nha_cung_cap", "ten_nha_cung_cap"} & normalized:
        return "bsn_purchase"
    return "bsn_sales"


def heuristic_suggestion(
    table: InputTable,
    target_template_id: str,
    target_headers: list[str],
    *,
    warnings: list[str] | None = None,
) -> MappingSuggestion:
    mapping: dict[str, MappingValue] = {}
    warnings = list(warnings or [])

    if target_template_id == "bsn_sales":
        for raw_header, target in BSN_SALES_DIRECT_MAPPING.items():
            resolved = _resolve_header(table.headers, raw_header)
            if resolved and _target_exists(target_headers, target):
                mapping[resolved] = target

        if "Column1" not in mapping:
            discount_header = _resolve_header(table.headers, "Giảm giá")
            if discount_header and "Tiền chiết khấu" in target_headers:
                mapping[discount_header] = "Tiền chiết khấu"
    else:
        semantic = detect_columns(table.headers)
        mapping.update(_semantic_to_template_mapping(semantic, target_headers))

    defaults = {
        key: value
        for key, value in CONVERSION_TYPES[target_template_id].defaults.items()
        if key in target_headers
    }
    defaults = sanitize_defaults_for_template(target_template_id, defaults, target_headers)
    formulas = {
        key: value
        for key, value in (BSN_SALES_FORMULAS if target_template_id == "bsn_sales" else {}).items()
        if key in target_headers
    }
    required_hits = _required_hits(target_template_id, mapping)
    confidence = min(0.95, 0.45 + required_hits * 0.08 + len(mapping) * 0.02)
    missing_required = _missing_required(target_template_id, mapping)
    if missing_required:
        warnings.append(
            "Thiếu mapping cho cột bắt buộc: " + ", ".join(missing_required)
        )
        confidence = min(confidence, 0.69)

    return MappingSuggestion(
        source="heuristic",
        confidence=round(confidence, 2),
        mapping=mapping,
        defaults=defaults,
        formulas=formulas,
        warnings=warnings,
    )


def profile_suggestion(profile: Any) -> MappingSuggestion:
    return MappingSuggestion(
        source="profile",
        confidence=profile.confidence,
        mapping=sanitize_mapping_for_template(profile.target_template_id, profile.mapping),
        defaults=sanitize_defaults_for_template(profile.target_template_id, profile.defaults),
        formulas=profile.formulas,
        warnings=[],
        profile_id=profile.id,
    )


def ai_suggestion_payload(
    table: InputTable,
    target_template_id: str,
    target_headers: list[str],
    nearby_profiles: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "target_template": {
            "id": target_template_id,
            "headers": target_headers,
        },
        "source": {
            "sheet_name": table.sheet_name,
            "headers": table.headers,
            "sample_rows": [_json_safe_row(row) for row in table.rows[:5]],
        },
        "nearby_profiles": nearby_profiles or [],
    }


def normalize_ai_suggestion(
    payload: dict[str, Any],
    fallback: MappingSuggestion,
    *,
    target_template_id: str,
    target_headers: list[str],
) -> MappingSuggestion:
    ai_mapping = _clean_mapping(payload.get("mapping"), {}, target_headers)
    mapping = sanitize_mapping_for_template(
        target_template_id, _merge_mapping(fallback.mapping, ai_mapping)
    )
    ai_defaults = _clean_target_dict(payload.get("defaults"), target_headers)
    defaults = sanitize_defaults_for_template(
        target_template_id,
        {**fallback.defaults, **ai_defaults},
        target_headers,
    )
    formulas = _clean_target_dict(payload.get("formulas"), target_headers) or fallback.formulas
    confidence = payload.get("confidence", fallback.confidence)
    try:
        confidence_float = max(fallback.confidence, max(0.0, min(1.0, float(confidence))))
    except (TypeError, ValueError):
        confidence_float = fallback.confidence
    warnings = list(fallback.warnings)
    notes = payload.get("notes")
    if isinstance(notes, list):
        warnings.extend(str(note) for note in notes if note)
    return MappingSuggestion(
        source="mixed" if ai_mapping else fallback.source,
        confidence=round(confidence_float, 2),
        mapping=mapping,
        defaults=defaults,
        formulas=formulas,
        warnings=warnings,
    )


def _merge_mapping(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for source_header, target in override.items():
        if source_header not in merged:
            merged[source_header] = target
    return merged


def sanitize_mapping_for_template(
    target_template_id: str, mapping: dict[str, MappingValue]
) -> dict[str, MappingValue]:
    if target_template_id != "bsn_sales":
        return mapping
    return {
        raw_header: target
        for raw_header, target in mapping.items()
        if not _targets_include(target, BSN_SALES_BLOCKED_AUTO_TARGETS)
    }


def sanitize_defaults_for_template(
    target_template_id: str,
    defaults: dict[str, Any] | None,
    target_headers: list[str] | None = None,
) -> dict[str, Any]:
    output = dict(defaults or {})
    if target_template_id != "bsn_sales":
        return output
    for header, value in BSN_SALES_DEFAULTS.items():
        if target_headers is None or header in target_headers:
            output.setdefault(header, value)
    return output


def _targets_include(target: MappingValue, blocked: set[str]) -> bool:
    targets = target if isinstance(target, list) else [target]
    return any(item in blocked for item in targets)


def apply_mapping(
    table: InputTable,
    target_headers: list[str],
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    defaults = defaults or {}
    formulas = formulas or {}
    output_rows: list[dict[str, Any]] = []
    for source_row in table.rows:
        record = {header: defaults.get(header, "") for header in target_headers if header}
        for raw_header, target_spec in mapping.items():
            if raw_header not in source_row:
                continue
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            for target in targets:
                if target in target_headers:
                    transformed = transform_value(source_row.get(raw_header), target)
                    if transformed in ("", None) and record.get(target) not in ("", None):
                        continue
                    record[target] = transformed
        for target, expression in formulas.items():
            if target in target_headers:
                record[target] = evaluate_formula(expression, record)
        if any(value not in ("", None) for value in record.values()):
            output_rows.append(record)
    return output_rows


def transform_value(value: Any, target_header: str) -> Any:
    if value is None:
        return ""
    normalized_target = normalize_header(target_header)
    if normalized_target == "han_su_dung" and isinstance(value, (datetime, date)):
        return value
    if normalized_target == "so_chung_tu":
        return _clean_invoice_number(value)
    if normalized_target == "dvt":
        return _normalize_unit(value)
    if "ngay" in normalized_target and "han_su_dung" not in normalized_target:
        parsed = parse_date(value)
        return parsed if parsed is not None else _clean_text(value)
    if any(hint in target_header.lower() for hint in NUMERIC_TARGET_HINTS):
        parsed_number = parse_number(value)
        if parsed_number is None:
            return ""
        return int(parsed_number) if float(parsed_number).is_integer() else parsed_number
    return _clean_text(value)


def evaluate_formula(expression: str, record: dict[str, Any]) -> Any:
    multiply_match = re.fullmatch(r"\$\{(.+?)\}\s*\*\s*\$\{(.+?)\}", expression.strip())
    if multiply_match:
        left = parse_number(record.get(multiply_match.group(1))) or 0
        right = parse_number(record.get(multiply_match.group(2))) or 0
        result = left * right
        return int(result) if float(result).is_integer() else result

    def replace(match: re.Match[str]) -> str:
        value = record.get(match.group(1), "")
        return "" if value is None else str(value)

    return re.sub(r"\$\{(.+?)\}", replace, expression)


def validate_mapping(
    target_template_id: str, mapping: dict[str, Any], target_headers: list[str]
) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for raw_header, target_spec in mapping.items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        for target in targets:
            if target not in target_headers:
                issues.append(
                    {
                        "field": str(raw_header),
                        "code": "unknown_target_header",
                        "message": f"Target header '{target}' is not in template {target_template_id}.",
                    }
                )
    for missing in _missing_required(target_template_id, mapping):
        issues.append(
            {
                "field": missing,
                "code": "missing_required_mapping",
                "message": f"Missing required MISA mapping for '{missing}'.",
            }
        )
    return issues


def _resolve_header(headers: list[str], requested: str) -> str | None:
    normalized_requested = normalize_header(requested)
    for header in headers:
        if normalize_header(header) == normalized_requested:
            return header
    return None


def _target_exists(target_headers: list[str], target: MappingValue) -> bool:
    targets = target if isinstance(target, list) else [target]
    return all(item in target_headers for item in targets)


def _semantic_to_template_mapping(
    semantic: dict[str, str], target_headers: list[str]
) -> dict[str, MappingValue]:
    candidates = {
        "invoice": "Số chứng từ (*)",
        "date": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
        "customer_code": "Mã khách hàng",
        "customer_name": "Tên khách hàng",
        "supplier_code": "Mã nhà cung cấp",
        "supplier_name": "Tên nhà cung cấp",
        "item_code": "Mã hàng (*)" if "Mã hàng (*)" in target_headers else "Mã dịch vụ (*)",
        "item_name": "Tên hàng" if "Tên hàng" in target_headers else "Tên dịch vụ",
        "unit": "ĐVT",
        "quantity": "Số lượng",
        "unit_price": "Đơn giá",
        "discount_amount": "Tiền chiết khấu",
        "lot": "Số lô",
        "expiry_date": "Hạn sử dụng",
    }
    output: dict[str, MappingValue] = {}
    for field, target in candidates.items():
        raw_header = semantic.get(field)
        if raw_header and _target_exists(target_headers, target):
            output[raw_header] = target
    return output


def _required_hits(target_template_id: str, mapping: dict[str, Any]) -> int:
    mapped_targets = _mapped_targets(mapping)
    return sum(
        1
        for header in CONVERSION_TYPES[target_template_id].required_output_headers
        if header in mapped_targets or header in CONVERSION_TYPES[target_template_id].defaults
    )


def _missing_required(target_template_id: str, mapping: dict[str, Any]) -> list[str]:
    mapped_targets = _mapped_targets(mapping)
    defaults = CONVERSION_TYPES[target_template_id].defaults
    return [
        header
        for header in CONVERSION_TYPES[target_template_id].required_output_headers
        if header not in mapped_targets and header not in defaults
    ]


def _mapped_targets(mapping: dict[str, Any]) -> set[str]:
    targets: set[str] = set()
    for target_spec in mapping.values():
        if isinstance(target_spec, list):
            targets.update(str(item) for item in target_spec)
        else:
            targets.add(str(target_spec))
    return targets


def _clean_mapping(
    mapping: Any, fallback: dict[str, MappingValue], target_headers: list[str]
) -> dict[str, MappingValue]:
    if not isinstance(mapping, dict):
        return fallback
    output: dict[str, MappingValue] = {}
    for raw_header, target_spec in mapping.items():
        if isinstance(target_spec, list):
            targets = [str(target) for target in target_spec if str(target) in target_headers]
            if targets:
                output[str(raw_header)] = targets
        elif str(target_spec) in target_headers:
            output[str(raw_header)] = str(target_spec)
    return output or fallback


def _clean_target_dict(payload: Any, target_headers: list[str]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {str(key): value for key, value in payload.items() if str(key) in target_headers}


def _clean_text(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _clean_invoice_number(value: Any) -> str:
    text = _clean_text(value)
    return re.sub(r"_\d+$", "", text)


def _normalize_unit(value: Any) -> str:
    text = _clean_text(value)
    if not text:
        return ""
    known_units = {
        "hop": "Hộp",
        "cai": "Cái",
        "chai": "Chai",
        "bo": "Bộ",
        "thung": "Thùng",
        "tuyp": "Tuýp",
        "lo": "Lọ",
    }
    return known_units.get(normalize_header(text), text)


def _json_safe_row(row: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in row.items():
        if isinstance(value, (datetime, date)):
            output[key] = value.isoformat()
        else:
            output[key] = value
    return output
