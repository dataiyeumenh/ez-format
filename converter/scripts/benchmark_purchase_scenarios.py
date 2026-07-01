from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from app.accounting_ai_context import build_accounting_mapping_context
from app.excel_io import read_input_table
from app.misa_templates import get_misa_template
from app.purchase_scenarios import build_purchase_scenarios, write_purchase_scenario_workbook


def run_purchase_scenario_benchmark(
    output_dir: Path,
    *,
    count: int = 100,
) -> dict[str, Any]:
    if count < 1 or count > 100:
        raise ValueError("count must be between 1 and 100")
    scenarios = build_purchase_scenarios()[:count]
    target_headers = get_misa_template("misa_purchase_domestic").headers
    target_set = set(target_headers)
    workbook_dir = output_dir / "benchmark-workbooks"
    workbook_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    parsed_ok = 0
    matching_alias_retrieval = 0
    matched_mapping_fields = 0
    expected_mapping_fields = 0
    dangerous_false_mapping = 0
    failures: list[dict[str, Any]] = []

    for scenario in scenarios:
        path = write_purchase_scenario_workbook(scenario, workbook_dir / f"{scenario.id}.xlsx")
        table = read_input_table(path)
        parse_matches = (
            table.sheet_name == scenario.expected_sheet
            and table.header_row_index + 1 == scenario.header_row
            and len(table.rows) == scenario.expected_row_count
        )
        if parse_matches:
            parsed_ok += 1
        context = build_accounting_mapping_context(
            target_template_id="misa_purchase_domestic",
            source_headers=table.headers,
            target_headers=target_headers,
        )
        top_example = context["few_shot_examples"][0]
        if top_example["alias_profile"] == scenario.alias_profile:
            matching_alias_retrieval += 1
        retrieved_mapping = top_example["expected_mapping"]
        expected_mapping_fields += len(scenario.expected_mapping)
        matched_mapping_fields += sum(
            1
            for raw_header, target_spec in scenario.expected_mapping.items()
            if retrieved_mapping.get(raw_header) == target_spec
        )
        for raw_header, target_spec in retrieved_mapping.items():
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            if raw_header not in table.headers or not set(targets).issubset(target_set):
                dangerous_false_mapping += 1
        if not parse_matches:
            failures.append(
                {
                    "scenario_id": scenario.id,
                    "sheet": table.sheet_name,
                    "header_row": table.header_row_index + 1,
                    "row_count": len(table.rows),
                }
            )

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    report = {
        "scenario_count": len(scenarios),
        "parsed_ok": parsed_ok,
        "matching_alias_retrieval": matching_alias_retrieval,
        "required_mapping_recall": round(
            matched_mapping_fields / expected_mapping_fields if expected_mapping_fields else 0.0,
            4,
        ),
        "dangerous_false_mapping": dangerous_false_mapping,
        "elapsed_ms": elapsed_ms,
        "failures": failures,
        "synthetic_only": True,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "purchase-scenario-benchmark.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark purchase mapping scenarios.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=100)
    args = parser.parse_args()
    print(
        json.dumps(
            run_purchase_scenario_benchmark(args.output, count=args.count),
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

