from __future__ import annotations

from copy import deepcopy

from app.excel_io import InputTable, read_input_table
from app.field_provenance import apply_master_data_to_drafts
from app.purchase_scenarios import build_purchase_scenarios, write_purchase_scenario_workbook
from app.reconstruction_workflow import _enforce_draft_limit, _master_data_context
from app.voucher_reconstruction import reconstruct_vouchers


def _table(rows: list[dict], headers: list[str] | None = None) -> InputTable:
    resolved_headers = headers or list(rows[0])
    return InputTable(
        headers=resolved_headers,
        rows=rows,
        sheet_name="ChiTietHoaDon",
        header_row_index=0,
    )


def test_reconstructs_multiple_lines_into_one_purchase_voucher():
    rows = [
        {
            "Số hóa đơn": "000123",
            "Ký hiệu hóa đơn": "1C26TAA",
            "Ngày hóa đơn": "01/07/2026",
            "Mã số thuế NCC": "0317262773",
            "Tên nhà cung cấp": "Nhà cung cấp A",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH01",
            "Tên hàng hóa dịch vụ": "Hàng 1",
            "Đơn vị tính": "Cái",
            "Số lượng": 2,
            "Đơn giá": 100_000,
            "Thành tiền chưa thuế": 200_000,
            "Thuế suất GTGT": 10,
            "Tiền thuế GTGT": 20_000,
        },
        {
            "Số hóa đơn": "",
            "Ký hiệu hóa đơn": "",
            "Ngày hóa đơn": "",
            "Mã số thuế NCC": "",
            "Tên nhà cung cấp": "",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH02",
            "Tên hàng hóa dịch vụ": "Hàng 2",
            "Đơn vị tính": "Cái",
            "Số lượng": 1,
            "Đơn giá": 50_000,
            "Thành tiền chưa thuế": 50_000,
            "Thuế suất GTGT": 10,
            "Tiền thuế GTGT": 5_000,
        },
    ]

    report = reconstruct_vouchers(_table(rows), mode="purchase")

    assert report.row_conservation.source_rows == 2
    assert report.row_conservation.assigned_rows == 2
    assert report.row_conservation.unresolved_rows == 0
    assert len(report.drafts) == 1
    draft = report.drafts[0]
    assert draft.direction == "purchase"
    assert draft.nature == "goods"
    assert draft.status == "ready"
    assert draft.header["invoice_number"].value == "000123"
    assert len(draft.lines) == 2
    assert draft.totals.amount == "250000"
    assert draft.totals.vat == "25000"
    assert draft.totals.payment == "275000"


def test_mixed_goods_and_services_requires_review():
    rows = [
        {
            "Số hóa đơn": "HD01",
            "Ký hiệu hóa đơn": "1C26TAA",
            "Mã số thuế NCC": "0317262773",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH01",
            "Số lượng": 1,
            "Đơn giá": 100_000,
            "Thành tiền": 100_000,
        },
        {
            "Số hóa đơn": "HD01",
            "Ký hiệu hóa đơn": "1C26TAA",
            "Mã số thuế NCC": "0317262773",
            "Phân loại": "Dịch vụ",
            "Mã hàng": "DV01",
            "Số lượng": 1,
            "Đơn giá": 200_000,
            "Thành tiền": 200_000,
        },
    ]

    report = reconstruct_vouchers(_table(rows), mode="purchase")

    assert len(report.drafts) == 1
    assert report.drafts[0].nature == "mixed"
    assert report.drafts[0].status == "needs_review"
    assert "mixed_document_nature" in {issue.code for issue in report.drafts[0].issues}


def test_workspace_tax_code_detects_purchase_direction():
    rows = [
        {
            "Số hóa đơn": "HD01",
            "Ký hiệu hóa đơn": "1C26TAA",
            "MST người bán": "0311111111",
            "MST người mua": "0317262773",
            "Tên người bán": "Nhà cung cấp A",
            "Tính chất HHDV": "Hàng hóa",
            "Mã SP trên HĐ": "HH01",
            "SL HĐ": 1,
            "Đơn giá chưa thuế": 100_000,
            "Tiền trước thuế": 100_000,
        }
    ]

    report = reconstruct_vouchers(
        _table(rows),
        mode="auto",
        workspace_tax_code="0317262773",
    )

    assert report.drafts[0].direction == "purchase"
    assert report.drafts[0].direction_trust == "verified"


def test_auto_direction_from_supplier_columns_requires_review():
    rows = [
        {
            "Số hóa đơn": "HD01",
            "Mã số thuế NCC": "0311111111",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH01",
            "Số lượng": 1,
            "Đơn vị tính": "Cái",
            "Đơn giá": 100_000,
            "Thành tiền": 100_000,
        }
    ]

    report = reconstruct_vouchers(_table(rows), mode="auto")

    draft = report.drafts[0]
    assert draft.direction == "purchase"
    assert draft.direction_trust == "suggested"
    assert draft.status == "needs_review"
    assert "document_direction_suggested" in {issue.code for issue in draft.issues}


def test_same_strong_key_with_conflicting_header_is_blocked():
    rows = [
        {
            "Số hóa đơn": "HD01",
            "Ký hiệu hóa đơn": "1C26TAA",
            "Ngày hóa đơn": "01/07/2026",
            "Mã số thuế NCC": "0317262773",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH01",
            "Số lượng": 1,
            "Đơn giá": 100_000,
            "Thành tiền": 100_000,
        },
        {
            "Số hóa đơn": "HD01",
            "Ký hiệu hóa đơn": "1C26TAA",
            "Ngày hóa đơn": "02/07/2026",
            "Mã số thuế NCC": "0317262773",
            "Phân loại": "Hàng hóa",
            "Mã hàng": "HH02",
            "Số lượng": 1,
            "Đơn giá": 200_000,
            "Thành tiền": 200_000,
        },
    ]

    report = reconstruct_vouchers(_table(rows), mode="purchase")

    assert len(report.drafts) == 1
    assert report.drafts[0].status == "blocked"
    assert "invoice_header_conflict" in {issue.code for issue in report.drafts[0].issues}


def test_reconstruction_is_deterministic():
    rows = [
        {
            "Số hóa đơn": "HD01",
            "Mã số thuế NCC": "0317262773",
            "Phân loại": "Dịch vụ",
            "Mã hàng": "DV01",
            "Số lượng": 1,
            "Đơn giá": 80_000,
            "Thành tiền": 80_000,
        }
    ]
    table = _table(rows)

    first = reconstruct_vouchers(table, mode="purchase")
    second = reconstruct_vouchers(deepcopy(table), mode="purchase")

    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_all_100_purchase_scenarios_preserve_rows_and_classification(tmp_path):
    for scenario in build_purchase_scenarios():
        path = write_purchase_scenario_workbook(scenario, tmp_path / f"{scenario.id}.xlsx")
        table = read_input_table(path)

        report = reconstruct_vouchers(table, mode="purchase")

        assert report.row_conservation.source_rows == scenario.expected_row_count
        assert report.row_conservation.assigned_rows == scenario.expected_row_count
        assert report.row_conservation.unresolved_rows == 0
        if scenario.category in {"goods", "service"}:
            assert {draft.nature for draft in report.drafts} == {scenario.category}
        elif scenario.category == "mixed":
            assert {draft.nature for draft in report.drafts} == {"goods", "service"}
        else:
            assert any(
                issue.code == "negative_amount_context_unclear"
                for draft in report.drafts
                for issue in draft.issues
            )


def test_reconstruction_marks_loaded_master_data_as_connected(monkeypatch):
    context = {"workspace": {"id": "workspace-1"}, "catalogs": {}}
    monkeypatch.setattr(
        "app.reconstruction_workflow.fetch_master_data_context",
        lambda _token: context,
    )

    loaded, status, message = _master_data_context(
        {"workspace_id": "workspace-1"},
        "context-token",
    )

    assert loaded == context
    assert status == "connected"
    assert message is None


def test_all_40_sales_variants_preserve_rows_classification_and_template():
    header_profiles = [
        {
            "invoice": "Số hóa đơn",
            "seller_tax": "MST người bán",
            "buyer_tax": "MST người mua",
            "customer": "Tên khách hàng",
            "item_type": "Phân loại",
            "item_code": "Mã hàng",
            "item_name": "Tên hàng",
            "unit": "Đơn vị tính",
            "quantity": "Số lượng",
            "unit_price": "Đơn giá",
            "amount": "Thành tiền",
        },
        {
            "invoice": "Mã hóa đơn",
            "seller_tax": "Mã số thuế người bán",
            "buyer_tax": "Mã số thuế người mua",
            "customer": "Tên khách hàng",
            "item_type": "Tính chất HHDV",
            "item_code": "Mã SP trên HĐ",
            "item_name": "Tên HHDV",
            "unit": "ĐVT HĐ",
            "quantity": "SL HĐ",
            "unit_price": "Đơn giá chưa thuế",
            "amount": "Tiền trước thuế",
        },
        {
            "invoice": "Invoice number",
            "seller_tax": "MST người bán",
            "buyer_tax": "MST người mua",
            "customer": "Tên khách hàng",
            "item_type": "Item type",
            "item_code": "Item code",
            "item_name": "Item name",
            "unit": "Unit",
            "quantity": "Quantity",
            "unit_price": "Unit price",
            "amount": "Net amount",
        },
        {
            "invoice": "SO_HD",
            "seller_tax": "MST người bán",
            "buyer_tax": "MST người mua",
            "customer": "Tên khách hàng",
            "item_type": "Loại hàng",
            "item_code": "MATHANG",
            "item_name": "TENDM",
            "unit": "DONVI",
            "quantity": "LUONG",
            "unit_price": "DGVND",
            "amount": "TTVND",
        },
        {
            "invoice": "Số HĐ điện tử",
            "seller_tax": "MST người bán",
            "buyer_tax": "MST người mua",
            "customer": "Tên khách hàng",
            "item_type": "Loại HHDV",
            "item_code": "Mã SKU bán",
            "item_name": "Nội dung hàng hóa dịch vụ",
            "unit": "DVT",
            "quantity": "SL bán",
            "unit_price": "Giá bán",
            "amount": "Thành tiền chưa thuế",
        },
    ]

    for index in range(40):
        headers = header_profiles[index % len(header_profiles)]
        nature = "goods" if index % 2 == 0 else "service"
        explicit_type = "Hàng hóa" if nature == "goods" else "Dịch vụ"
        row = {
            headers["invoice"]: f"BH{index:04d}",
            headers["seller_tax"]: "0319999999",
            headers["buyer_tax"]: f"031{index:07d}"[:10],
            headers["customer"]: f"Khách hàng {index}",
            headers["item_type"]: explicit_type,
            headers["item_code"]: f"{'HH' if nature == 'goods' else 'DV'}{index:03d}",
            headers["item_name"]: f"{'Hàng hóa' if nature == 'goods' else 'Dịch vụ'} {index}",
            headers["unit"]: "Cái" if nature == "goods" else "Lần",
            headers["quantity"]: 1,
            headers["unit_price"]: 100_000 + index,
            headers["amount"]: 100_000 + index,
        }
        report = reconstruct_vouchers(
            _table([row], headers=list(row)),
            mode="auto",
            workspace_tax_code="0319999999",
        )

        assert report.row_conservation.assigned_rows == 1
        assert report.row_conservation.unresolved_rows == 0
        assert len(report.drafts) == 1
        draft = report.drafts[0]
        assert draft.direction == "sales"
        assert draft.direction_trust == "verified"
        assert draft.nature == nature
        assert draft.template_id == (
            "bsn_sales" if nature == "goods" else "sales_service"
        )


def test_reconstruction_draft_limit_rejects_unbounded_document_count(monkeypatch):
    monkeypatch.setenv("RECONSTRUCTION_MAX_DRAFTS", "1")
    report = reconstruct_vouchers(
        _table(
            [
                {
                    "Số hóa đơn": "HD01",
                    "Mã số thuế NCC": "0311111111",
                    "Phân loại": "Hàng hóa",
                    "Mã hàng": "HH01",
                    "Số lượng": 1,
                    "Đơn vị tính": "Cái",
                    "Đơn giá": 100,
                    "Thành tiền": 100,
                },
                {
                    "Số hóa đơn": "HD02",
                    "Mã số thuế NCC": "0312222222",
                    "Phân loại": "Hàng hóa",
                    "Mã hàng": "HH02",
                    "Số lượng": 1,
                    "Đơn vị tính": "Cái",
                    "Đơn giá": 100,
                    "Thành tiền": 100,
                },
            ]
        ),
        mode="purchase",
    )

    try:
        _enforce_draft_limit(report)
    except ValueError as exc:
        assert "chia nhỏ" in str(exc)
    else:
        raise AssertionError("Expected draft limit error")


def test_phase1_master_data_alias_updates_canonical_field_and_provenance():
    report = reconstruct_vouchers(
        _table(
            [
                {
                    "Số hóa đơn": "HD01",
                    "Mã số thuế NCC": "0311111111",
                    "Phân loại": "Hàng hóa",
                    "Mã hàng": "Tên hàng raw",
                    "Số lượng": 1,
                    "Đơn vị tính": "Cái",
                    "Đơn giá": 100,
                    "Thành tiền": 100,
                }
            ]
        ),
        mode="purchase",
    )
    context = {
        "catalogs": {
            "item": {
                "entries": [
                    {
                        "code": "HH001",
                        "normalizedCode": "HH001",
                        "name": "Hàng chuẩn",
                        "normalizedName": "hang chuan",
                        "active": True,
                    }
                ],
                "aliases": [
                    {
                        "sourceSystem": "reconstruction",
                        "normalizedRawValue": "ten hang raw",
                        "targetCode": "HH001",
                        "normalizedTargetCode": "HH001",
                    }
                ],
            }
        }
    }

    apply_master_data_to_drafts(report.drafts, context)

    item = report.drafts[0].lines[0].fields["item_code"]
    assert item.value == "HH001"
    assert item.provenance[0].source == "confirmed_alias"
