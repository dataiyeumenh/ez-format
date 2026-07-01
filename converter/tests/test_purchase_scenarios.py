from collections import Counter

from app.excel_io import read_input_table
from app.misa_templates import get_misa_template
from app.purchase_scenarios import (
    build_purchase_scenarios,
    write_purchase_scenario_workbook,
)


def test_purchase_scenario_catalog_has_100_unique_covered_cases():
    scenarios = build_purchase_scenarios()

    assert len(scenarios) == 100
    assert len({scenario.id for scenario in scenarios}) == 100
    assert len({scenario.schema_fingerprint for scenario in scenarios}) == 100
    assert Counter(item.category for item in scenarios) == {
        "goods": 25,
        "service": 25,
        "mixed": 25,
        "adjustment": 25,
    }
    assert set(item.alias_profile for item in scenarios) == {
        "vietnamese",
        "no_accent",
        "accounting_codes",
        "english",
        "einvoice_export",
    }
    assert set(item.layout_profile for item in scenarios) == {
        "flat",
        "title_rows",
        "summary_and_detail",
        "noisy_reordered",
        "merged_hidden_formula",
    }


def test_purchase_scenario_expected_mappings_only_use_real_template_headers():
    target_headers = set(get_misa_template("misa_purchase_domestic").headers)

    for scenario in build_purchase_scenarios():
        assert scenario.expected_mapping
        for target_spec in scenario.expected_mapping.values():
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            assert set(targets).issubset(target_headers)
        assert scenario.source_url.startswith("https://helpact.misa.vn/")


def test_generated_purchase_workbooks_are_stable_and_readable(tmp_path):
    scenarios = build_purchase_scenarios()
    representatives = [scenarios[index] for index in (0, 24, 49, 74, 99)]

    for scenario in representatives:
        first = write_purchase_scenario_workbook(
            scenario, tmp_path / f"{scenario.id}-first.xlsx"
        )
        second = write_purchase_scenario_workbook(
            scenario, tmp_path / f"{scenario.id}-second.xlsx"
        )
        assert first.read_bytes() == second.read_bytes()

        table = read_input_table(first)
        assert table.sheet_name == scenario.expected_sheet
        assert table.header_row_index + 1 == scenario.header_row
        assert len(table.rows) == scenario.expected_row_count
        assert set(scenario.expected_mapping).issubset(table.headers)

