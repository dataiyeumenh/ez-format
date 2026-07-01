from __future__ import annotations

from typing import Any

from app.normalization import normalize_header
from app.purchase_scenarios import ALIASES, build_purchase_scenarios


PURCHASE_TARGET_IDS = {
    "misa_purchase_domestic",
    "bsn_purchase",
    "purchase_goods",
    "purchase_service",
}


def build_accounting_mapping_context(
    *,
    target_template_id: str,
    source_headers: list[str],
    target_headers: list[str],
    max_examples: int = 6,
) -> dict[str, Any]:
    if target_template_id not in PURCHASE_TARGET_IDS:
        return {}

    examples = _select_examples(source_headers, target_headers, max_examples=max_examples)
    return {
        "knowledge_version": "purchase-mapping-v1",
        "purpose": "synthetic Vietnamese purchase-input mapping guidance",
        "required_field_policy": "template_headers_with_(*)_are_required",
        "safety_rules": [
            "copy_source_and_target_headers_exactly",
            "do_not_invent_codes",
            "do_not_invent_vat_rates",
            "omit_uncertain_mapping_instead_of_guessing",
            "ai_never_overrides_backend_validation",
        ],
        "review_rules": [
            "account_review_required",
            "vat_eligibility_requires_accountant_review",
            "goods_service_classification_requires_review_when_source_is_ambiguous",
            "master_data_codes_may_not_exist_in_target_misa_company",
        ],
        "semantic_aliases": {
            semantic: [profile[semantic] for profile in ALIASES.values()]
            for semantic in ALIASES["vietnamese"]
        },
        "few_shot_examples": examples,
        "source_urls": [
            "https://helpact.misa.vn/kb/html_10050000/",
            "https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/",
        ],
    }


def _select_examples(
    source_headers: list[str],
    target_headers: list[str],
    *,
    max_examples: int,
) -> list[dict[str, Any]]:
    source_normalized = {normalize_header(header) for header in source_headers if header}
    target_set = set(target_headers)
    scored: list[tuple[float, Any]] = []
    for scenario in build_purchase_scenarios():
        scenario_headers = set(scenario.expected_mapping)
        scenario_normalized = {normalize_header(header) for header in scenario_headers}
        overlap = len(source_normalized & scenario_normalized)
        union = len(source_normalized | scenario_normalized) or 1
        score = overlap / union
        scored.append((score, scenario))

    scored.sort(key=lambda item: (-item[0], item[1].id))
    selected: list[Any] = []
    used_profiles: set[str] = set()
    for _, scenario in scored:
        if scenario.alias_profile in used_profiles:
            continue
        selected.append(scenario)
        used_profiles.add(scenario.alias_profile)
        if len(selected) >= min(max_examples, len(ALIASES)):
            break

    examples: list[dict[str, Any]] = []
    for scenario in selected:
        mapping: dict[str, Any] = {}
        for raw_header, target_spec in scenario.expected_mapping.items():
            if source_normalized and normalize_header(raw_header) not in source_normalized:
                continue
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            filtered_targets = [target for target in targets if target in target_set]
            if filtered_targets:
                mapping[raw_header] = (
                    filtered_targets[0] if len(filtered_targets) == 1 else filtered_targets
                )
        if not mapping:
            for raw_header, target_spec in list(scenario.expected_mapping.items())[:4]:
                targets = target_spec if isinstance(target_spec, list) else [target_spec]
                filtered_targets = [target for target in targets if target in target_set]
                if filtered_targets:
                    mapping[raw_header] = (
                        filtered_targets[0] if len(filtered_targets) == 1 else filtered_targets
                    )
        examples.append(
            {
                "scenario_id": scenario.id,
                "category": scenario.category,
                "alias_profile": scenario.alias_profile,
                "raw_headers": list(scenario.expected_mapping)[:12],
                "expected_mapping": mapping,
                "notes": ["synthetic", *scenario.warnings],
            }
        )
    return examples

