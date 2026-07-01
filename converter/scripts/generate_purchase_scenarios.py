from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.purchase_scenarios import (
    build_purchase_scenarios,
    scenario_catalog_payload,
    write_purchase_scenario_workbook,
)


def generate_scenario_artifacts(
    output_dir: Path,
    *,
    count: int = 100,
    write_workbooks: bool = True,
) -> dict[str, Any]:
    if count < 1 or count > 100:
        raise ValueError("count must be between 1 and 100")
    scenarios = build_purchase_scenarios()[:count]
    output_dir.mkdir(parents=True, exist_ok=True)
    catalog_path = output_dir / "purchase-scenarios.json"
    catalog_path.write_text(
        json.dumps(scenario_catalog_payload(scenarios), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    workbook_count = 0
    if write_workbooks:
        workbook_dir = output_dir / "workbooks"
        workbook_dir.mkdir(parents=True, exist_ok=True)
        for scenario in scenarios:
            write_purchase_scenario_workbook(
                scenario, workbook_dir / f"{scenario.id}.xlsx"
            )
            workbook_count += 1

    report = {
        "scenario_count": len(scenarios),
        "workbook_count": workbook_count,
        "catalog_path": str(catalog_path),
        "synthetic_only": True,
    }
    (output_dir / "generation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate synthetic purchase scenarios.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--catalog-only", action="store_true")
    args = parser.parse_args()
    report = generate_scenario_artifacts(
        args.output,
        count=args.count,
        write_workbooks=not args.catalog_only,
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

