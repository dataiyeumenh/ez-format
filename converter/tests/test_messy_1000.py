import json
import random
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl
import xlrd

from app.ai_assistant import suggest_mapping_for_file
from app.conversion_types import CONVERSION_TYPES
from app.converter import convert_file, validate_file
from app.error_check import check_file_for_errors
from app.excel_io import find_header_row


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / ".artifacts" / "messy-1000"

SALES_BASE_HEADERS = [
    "Số HĐ bán lẻ",
    "Ngày bán",
    "Người mua hàng",
    "Mã SKU bán",
    "Tên mặt hàng bán",
    "Đơn vị lẻ",
    "SL bán",
    "Giá bán",
    "Tổng dòng bán",
    "CK %",
    "Giảm giá dòng",
    "VAT %",
    "Tiền thuế GTGT",
    "Tổng tiền hàng",
    "Khách phải trả",
    "PT thanh toán bán",
    "TK Nợ bán",
    "TK DT bán",
    "TK thuế bán",
    "TK giá vốn bán",
    "TK kho bán",
    "TK CK bán",
]

PURCHASE_BASE_HEADERS = [
    "Số PN nội bộ",
    "Ngày nhập",
    "Mã NCC nội bộ",
    "Tên NCC đầy đủ",
    "Mã SKU mua",
    "Tên hàng mua",
    "ĐVT mua",
    "SL nhập",
    "Giá mua",
    "Tổng dòng mua",
    "CK mua %",
    "Giảm giá mua",
    "VAT mua %",
    "Tiền thuế mua",
    "PT thanh toán mua",
    "TK kho/chi phí mua",
    "TK công nợ/tiền mua",
    "TK thuế mua",
]


def test_messy_1000_records_cover_all_backend_conversion_flows(tmp_path):
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    sales_path = tmp_path / "messy_sales_500.xlsx"
    purchase_path = tmp_path / "messy_purchase_500.xlsx"
    sales_expected = _write_sales_workbook(sales_path, 500, seed=20260526)
    purchase_expected = _write_purchase_workbook(purchase_path, 500, seed=20260527)

    cases = {
        "bsn_sales": (sales_path, sales_expected, "sales"),
        "sales_goods": (sales_path, sales_expected, "sales"),
        "sales_service": (sales_path, sales_expected, "sales"),
        "bsn_purchase": (purchase_path, purchase_expected, "purchase"),
        "purchase_goods": (purchase_path, purchase_expected, "purchase"),
        "purchase_service": (purchase_path, purchase_expected, "purchase"),
    }
    report_payload: dict[str, Any] = {
        "seed": {"sales": 20260526, "purchase": 20260527},
        "input_records": 1000,
        "cases": {},
    }

    for conversion_type, (input_path, expected_rows, flow) in cases.items():
        suggestion = suggest_mapping_for_file(
            input_path,
            conversion_type,
            {"ai_mode": "mock"},
        )
        assert suggestion.ok is True
        options = {
            "column_mapping": suggestion.suggested_mapping,
            "allow_calculation_warnings": True,
        }

        validation = validate_file(input_path, conversion_type, options)
        assert validation.ok is True
        assert validation.summary.input_rows == len(expected_rows)
        warning_codes = {warning.code for warning in validation.warnings}
        assert {
            "calculation_line_amount_mismatch",
            "calculation_discount_mismatch",
            "calculation_vat_mismatch",
        }.issubset(warning_codes)
        if flow == "sales":
            assert {
                "calculation_invoice_subtotal_mismatch",
                "calculation_payable_mismatch",
            }.issubset(warning_codes)

        error_check = check_file_for_errors(input_path, conversion_type, options)
        assert error_check.summary.input_rows == len(expected_rows)
        assert error_check.summary.accounting_issue_count > 0
        accounting_codes = {
            issue.code for issue in error_check.issues if issue.category == "accounting"
        }
        if flow == "sales":
            assert {
                "accounting_wrong_sales_debit_account",
                "accounting_wrong_sales_revenue_account",
                "accounting_wrong_output_vat_account",
            }.issubset(accounting_codes)
        else:
            assert {
                "accounting_wrong_purchase_payable_account",
                "accounting_wrong_input_vat_account",
            }.issubset(accounting_codes)

        blocked_output_path = tmp_path / f"{conversion_type}_blocked.xls"
        blocked = convert_file(input_path, conversion_type, blocked_output_path, {
            "column_mapping": suggestion.suggested_mapping,
        })
        assert blocked.ok is True
        assert not blocked_output_path.exists()

        output_path = tmp_path / f"{conversion_type}_messy_1000.xls"
        converted = convert_file(input_path, conversion_type, output_path, options)
        assert converted.ok is True
        assert output_path.exists()
        _assert_misa_output(output_path, conversion_type, expected_rows)

        artifact_output = ARTIFACT_DIR / f"{conversion_type}_messy_1000.xls"
        artifact_output.write_bytes(output_path.read_bytes())
        report_payload["cases"][conversion_type] = {
            "flow": flow,
            "input_rows": validation.summary.input_rows,
            "warning_count": validation.summary.warning_count,
            "warning_codes": sorted(warning_codes),
            "accounting_issue_count": error_check.summary.accounting_issue_count,
            "accounting_codes": sorted(accounting_codes),
            "output": str(artifact_output),
        }

    report_path = ARTIFACT_DIR / "messy-1000-test-report.json"
    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    assert report_path.exists()


def test_generated_10000_rows_accounting_acceptance_pack(tmp_path):
    artifact_dir = ROOT / ".artifacts" / "messy-10000"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    sales_path = tmp_path / "messy_sales_5000.xlsx"
    purchase_path = tmp_path / "messy_purchase_5000.xlsx"
    sales_expected = _write_sales_workbook(sales_path, 5000, seed=20260601)
    purchase_expected = _write_purchase_workbook(purchase_path, 5000, seed=20260602)

    sales_suggestion = suggest_mapping_for_file(sales_path, "sales_goods", {"ai_mode": "mock"})
    purchase_suggestion = suggest_mapping_for_file(
        purchase_path,
        "purchase_goods",
        {"ai_mode": "mock"},
    )
    sales_report = check_file_for_errors(
        sales_path,
        "sales_goods",
        {
            "column_mapping": sales_suggestion.suggested_mapping,
            "allow_calculation_warnings": True,
            "strict": True,
        },
    )
    purchase_report = check_file_for_errors(
        purchase_path,
        "purchase_goods",
        {
            "column_mapping": purchase_suggestion.suggested_mapping,
            "allow_calculation_warnings": True,
            "strict": True,
        },
    )

    assert len(sales_expected) + len(purchase_expected) == 10000
    assert sales_report.summary.input_rows == 5000
    assert purchase_report.summary.input_rows == 5000
    assert sales_report.strict_blocked is True
    assert purchase_report.strict_blocked is True
    assert sales_report.summary.accounting_issue_count > 0
    assert purchase_report.summary.accounting_issue_count > 0

    report_payload = {
        "seed": {"sales": 20260601, "purchase": 20260602},
        "input_records": 10000,
        "sales": sales_report.model_dump(mode="json"),
        "purchase": purchase_report.model_dump(mode="json"),
    }
    report_path = artifact_dir / "messy-10000-test-report.json"
    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    assert report_path.exists()


def _write_sales_workbook(path: Path, count: int, *, seed: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    headers = SALES_BASE_HEADERS[:]
    rng.shuffle(headers)
    rows: list[dict[str, Any]] = []

    for group_index in range(count // 2):
        group_rows: list[dict[str, Any]] = []
        group_subtotal = 0
        group_vat = 0
        invoice = f"HDX{group_index + 1:05d}"
        for offset in range(2):
            row_index = group_index * 2 + offset
            quantity = row_index % 9 + 1
            unit_price = 10000 + (row_index % 37) * 750
            discount_rate = 0.05 if row_index % 4 == 0 else 0
            vat_rate = (0.1, 0.08, 0)[row_index % 3]
            gross = quantity * unit_price
            discount = round(gross * discount_rate)
            line_amount = gross - discount
            vat_amount = round(line_amount * vat_rate)
            group_subtotal += line_amount
            group_vat += vat_amount
            item_code = f"SKU-B{row_index + 1:05d}"
            if group_index % 50 == 0 and offset == 1:
                item_code = group_rows[0]["item_code"]
            group_rows.append(
                {
                    "invoice": invoice,
                    "date": _messy_date(row_index),
                    "customer": f"Khách lẻ {group_index + 1:04d}",
                    "item_code": item_code,
                    "item_name": f"Hàng bán {row_index + 1:05d}",
                    "unit": "Cái" if row_index % 2 else "Hộp",
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "gross": gross,
                    "line_amount": line_amount,
                    "discount_rate": discount_rate,
                    "discount": discount,
                    "vat_rate": vat_rate,
                    "vat_amount": vat_amount,
                }
            )

        subtotal_actual = group_subtotal + (37 if group_index % 83 == 0 else 0)
        payable_actual = group_subtotal + group_vat + (41 if group_index % 89 == 0 else 0)
        for row in group_rows:
            row_number = len(rows) + 1
            output_row = {
                "Số HĐ bán lẻ": row["invoice"],
                "Ngày bán": row["date"],
                "Người mua hàng": row["customer"],
                "Mã SKU bán": row["item_code"],
                "Tên mặt hàng bán": row["item_name"],
                "Đơn vị lẻ": row["unit"],
                "SL bán": row["quantity"],
                "Giá bán": _messy_money(row["unit_price"], row_number),
                "Tổng dòng bán": _messy_money(
                    row["line_amount"] + (29 if row_number % 137 == 0 else 0),
                    row_number + 1,
                ),
                "CK %": _messy_percent(row["discount_rate"], row_number),
                "Giảm giá dòng": _messy_money(
                    row["discount"] + (503 if row_number % 149 == 0 else 0),
                    row_number + 2,
                ),
                "VAT %": _messy_percent(row["vat_rate"], row_number + 3),
                "Tiền thuế GTGT": _messy_money(
                    row["vat_amount"] + (67 if row_number % 157 == 0 else 0),
                    row_number + 4,
                ),
                "Tổng tiền hàng": _messy_money(subtotal_actual, row_number + 5),
                "Khách phải trả": _messy_money(payable_actual, row_number + 6),
                "PT thanh toán bán": "Chưa thu tiền",
                "TK Nợ bán": "331" if row_number % 173 == 0 else "131",
                "TK DT bán": "331" if row_number % 181 == 0 else "5111",
                "TK thuế bán": "1331" if row_number % 191 == 0 else "33311",
                "TK giá vốn bán": "1561" if row_number % 199 == 0 else "632",
                "TK kho bán": "632" if row_number % 211 == 0 else "1561",
                "TK CK bán": "5211" if row_number % 223 == 0 else "5111",
            }
            rows.append(
                {
                    "values": output_row,
                    "invoice": row["invoice"],
                    "item_code": row["item_code"],
                    "quantity": row["quantity"],
                    "unit_price": row["unit_price"],
                    "mapped_amount": row["gross"],
                }
            )

    _write_workbook(path, headers, [row["values"] for row in rows])
    return rows


def _write_purchase_workbook(path: Path, count: int, *, seed: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    headers = PURCHASE_BASE_HEADERS[:]
    rng.shuffle(headers)
    rows: list[dict[str, Any]] = []

    for row_index in range(count):
        quantity = row_index % 7 + 1
        unit_price = 8000 + (row_index % 31) * 900
        discount_rate = 0.03 if row_index % 5 == 0 else 0
        vat_rate = (0.1, 0.05, 0)[row_index % 3]
        gross = quantity * unit_price
        discount = round(gross * discount_rate)
        line_amount = gross - discount
        vat_amount = round(line_amount * vat_rate)
        row_number = row_index + 1
        output_row = {
            "Số PN nội bộ": f"PNX{row_index + 1:05d}",
            "Ngày nhập": _messy_date(row_index + 17),
            "Mã NCC nội bộ": f"NCC{row_index % 23 + 1:03d}",
            "Tên NCC đầy đủ": f"Nhà cung cấp {row_index % 23 + 1:03d}",
            "Mã SKU mua": f"SKU-M{row_index + 1:05d}",
            "Tên hàng mua": f"Hàng mua {row_index + 1:05d}",
            "ĐVT mua": "Cái",
            "SL nhập": quantity,
            "Giá mua": _messy_money(unit_price, row_number),
            "Tổng dòng mua": _messy_money(
                line_amount + (23 if row_number % 131 == 0 else 0),
                row_number + 1,
            ),
            "CK mua %": _messy_percent(discount_rate, row_number + 2),
            "Giảm giá mua": _messy_money(
                discount + (503 if row_number % 151 == 1 else 0),
                row_number + 3,
            ),
            "VAT mua %": _messy_percent(vat_rate, row_number + 4),
            "Tiền thuế mua": _messy_money(
                vat_amount + (47 if row_number % 151 == 0 else 0),
                row_number + 5,
            ),
            "PT thanh toán mua": "Chưa thanh toán",
            "TK kho/chi phí mua": "5111" if row_number % 163 == 0 else "1561",
            "TK công nợ/tiền mua": "131" if row_number % 167 == 0 else "331",
            "TK thuế mua": "33311" if row_number % 179 == 0 else "1331",
        }
        rows.append(
            {
                "values": output_row,
                "receipt": output_row["Số PN nội bộ"],
                "item_code": output_row["Mã SKU mua"],
                "quantity": quantity,
                "unit_price": unit_price,
                "mapped_amount": gross,
            }
        )

    _write_workbook(path, headers, [row["values"] for row in rows])
    return rows


def _write_workbook(path: Path, headers: list[str], records: list[dict[str, Any]]) -> None:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Generated by EzFormat 1000 messy regression"])
    sheet.append(["Rows include shuffled columns, mixed date/money/percent formats and blank lines."])
    sheet.append(headers)
    for index, record in enumerate(records, start=1):
        sheet.append([record.get(header) for header in headers])
        if index % 50 == 0:
            sheet.append([None for _ in headers])
    workbook.save(path)


def _assert_misa_output(
    output_path: Path,
    conversion_type: str,
    expected_rows: list[dict[str, Any]],
) -> None:
    book = xlrd.open_workbook(str(output_path))
    sheet = book.sheet_by_index(0)
    header_row = find_header_row(sheet)
    headers = {
        str(sheet.cell_value(header_row, col)).strip(): col
        for col in range(sheet.ncols)
        if str(sheet.cell_value(header_row, col)).strip()
    }

    for required_header in CONVERSION_TYPES[conversion_type].required_output_headers:
        assert required_header in headers

    data_row = header_row + 1
    first_expected = expected_rows[0]
    document_header = "Số chứng từ (*)"
    if document_header not in headers and "Số phiếu nhập (*)" in headers:
        document_header = "Số phiếu nhập (*)"
    item_header = "Mã hàng (*)" if "Mã hàng (*)" in headers else "Mã dịch vụ (*)"

    expected_document = first_expected.get("invoice") or first_expected.get("receipt")
    assert sheet.cell_value(data_row, headers[document_header]) == expected_document
    assert sheet.cell_value(data_row, headers[item_header]) == first_expected["item_code"]
    assert sheet.cell_value(data_row, headers["Số lượng"]) == first_expected["quantity"]
    assert sheet.cell_value(data_row, headers["Đơn giá"]) == first_expected["unit_price"]
    assert sheet.cell_value(data_row, headers["Thành tiền"]) == first_expected["mapped_amount"]
    assert sheet.nrows >= data_row + len(expected_rows)


def _messy_date(index: int) -> Any:
    if index % 3 == 0:
        return datetime(2025, 12, index % 28 + 1)
    if index % 3 == 1:
        return f"{index % 28 + 1:02d}/12/2025"
    return f"2025-12-{index % 28 + 1:02d}"


def _messy_money(value: int | float, index: int) -> int | float | str:
    number = int(round(value))
    mode = index % 4
    if mode == 0:
        return number
    if mode == 1:
        return f"{number:,}"
    if mode == 2:
        return f"{number:,}".replace(",", ".")
    return f"{number} VNĐ"


def _messy_percent(value: float, index: int) -> int | float | str:
    percent = int(round(value * 100))
    if index % 3 == 0:
        return value
    if index % 3 == 1:
        return percent
    return f"{percent}%"
