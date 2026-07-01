import json

from app.accounting_ai_context import build_accounting_mapping_context
from app.excel_io import read_input_table
from app.misa_templates import get_misa_template
from app.purchase_scenarios import build_purchase_scenarios, write_purchase_scenario_workbook
from scripts.generate_purchase_scenarios import generate_scenario_artifacts
from scripts.benchmark_purchase_scenarios import run_purchase_scenario_benchmark


def test_all_100_purchase_scenarios_parse_and_retrieve_matching_ai_knowledge(tmp_path):
    target_headers = get_misa_template("misa_purchase_domestic").headers
    failures = []

    for scenario in build_purchase_scenarios():
        path = write_purchase_scenario_workbook(scenario, tmp_path / f"{scenario.id}.xlsx")
        table = read_input_table(path)
        context = build_accounting_mapping_context(
            target_template_id="misa_purchase_domestic",
            source_headers=table.headers,
            target_headers=target_headers,
        )
        actual = {
            "sheet": table.sheet_name,
            "header_row": table.header_row_index + 1,
            "rows": len(table.rows),
            "top_alias": context["few_shot_examples"][0]["alias_profile"],
        }
        expected = {
            "sheet": scenario.expected_sheet,
            "header_row": scenario.header_row,
            "rows": scenario.expected_row_count,
            "top_alias": scenario.alias_profile,
        }
        if actual != expected:
            failures.append({"id": scenario.id, "expected": expected, "actual": actual})

    assert failures == []


def test_scenario_cli_exports_catalog_and_requested_workbooks(tmp_path):
    report = generate_scenario_artifacts(tmp_path, count=7, write_workbooks=True)

    catalog = json.loads((tmp_path / "purchase-scenarios.json").read_text(encoding="utf-8"))
    assert report["scenario_count"] == 7
    assert report["workbook_count"] == 7
    assert len(catalog) == 7
    assert len(list((tmp_path / "workbooks").glob("*.xlsx"))) == 7


def test_benchmark_reports_safe_knowledge_retrieval_for_all_scenarios(tmp_path):
    report = run_purchase_scenario_benchmark(tmp_path, count=100)

    assert report["scenario_count"] == 100
    assert report["parsed_ok"] == 100
    assert report["matching_alias_retrieval"] == 100
    assert report["required_mapping_recall"] == 1.0
    assert report["dangerous_false_mapping"] == 0
    assert (tmp_path / "purchase-scenario-benchmark.json").exists()
