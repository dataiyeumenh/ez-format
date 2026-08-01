from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import openpyxl

CONVERTER_ROOT = Path(__file__).resolve().parents[1]
if str(CONVERTER_ROOT) not in sys.path:
    sys.path.insert(0, str(CONVERTER_ROOT))

from app.converter import convert_file
from app.misa_biff import scrub_ole_metadata_copy
from app.misa_templates import get_misa_template


ROW_COUNT = 1930
FIXED_TIMESTAMP = datetime(2000, 1, 1)
RAW_HEADERS = (
    "Chi nhánh",
    "Mã hóa đơn",
    "Mã vận đơn",
    "Địa chỉ lấy hàng",
    "Mã đối soát",
    "Phí trả ĐTGH",
    "Thời gian",
    "Thời gian tạo",
    "Ngày cập nhật",
    "Mã đặt hàng",
    "Mã trả hàng",
    "Mã khách hàng",
    "Tên khách hàng",
    "Email",
    "Điện thoại",
    "Địa chỉ (Khách hàng)",
    "Khu vực (Khách hàng)",
    "Phường/Xã (Khách hàng)",
    "Ngày sinh",
    "Bảng giá",
    "Người bán",
    "Kênh bán",
    "Người tạo",
    "Đối tác giao hàng",
    "Người nhận",
    "Điện thoại (Người nhận)",
    "Địa chỉ (Người nhận)",
    "Khu vực (Người nhận)",
    "Phường/Xã (Người nhận)",
    "Dịch vụ",
    "Trọng lượng (gram)",
    "Dài",
    "Rộng",
    "Cao",
    "Ghi chú trạng thái giao hàng",
    "Ghi chú giao hàng",
    "Ghi chú",
    "Tổng tiền hàng",
    "Giảm giá hóa đơn",
    "VAT",
    "Thu khác",
    "Khách cần trả",
    "Khách đã trả",
    "Tiền mặt",
    "Thẻ",
    "Ví",
    "Chuyển khoản",
    "Còn cần thu (COD)",
    "Thời gian giao hàng",
    "Trạng thái",
    "Trạng thái giao hàng",
    "Mã hàng",
    "Mã vạch",
    "Tên hàng",
    "Thương hiệu",
    "ĐVT",
    "Lô",
    "Hạn sử dụng",
    "Ghi chú hàng hóa",
    "Số lượng",
    "Đơn giá",
    "Giảm giá %",
    "Giảm giá",
    "Giá bán",
    "Thành tiền",
    "Column1",
)


def _synthetic_row(index: int) -> list[object]:
    customer_number = ((index - 1) % 100) + 1
    item_number = ((index - 1) % 50) + 1
    quantity = ((index - 1) % 10) + 1
    unit_price = 100000 + (((index - 1) % 5) * 10000)
    discount = 5000 if (index - 1) % 4 == 0 else 0
    timestamp = datetime(2026, 1, 1, 8, 0) + timedelta(minutes=index - 1)
    customer_code = "" if index == 114 else f"SYN-CUSTOMER-{customer_number:03d}"
    unit = "" if index == 2 else "SYN-UNIT"
    total = quantity * unit_price
    values = {
        "Chi nhánh": "SYN-BRANCH",
        "Mã hóa đơn": f"SYN-INV-{index:06d}",
        "Mã vận đơn": f"SYN-SHIP-{index:06d}",
        "Địa chỉ lấy hàng": "SYN-PICKUP-ADDRESS",
        "Mã đối soát": f"SYN-RECON-{index:06d}",
        "Phí trả ĐTGH": 0,
        "Thời gian": timestamp,
        "Thời gian tạo": timestamp,
        "Ngày cập nhật": timestamp,
        "Mã đặt hàng": f"SYN-ORDER-{index:06d}",
        "Mã trả hàng": "",
        "Mã khách hàng": customer_code,
        "Tên khách hàng": f"SYN-CUSTOMER-NAME-{customer_number:03d}",
        "Email": f"SYN-EMAIL-{customer_number:03d}@example.invalid",
        "Điện thoại": f"SYN-PHONE-{customer_number:03d}",
        "Địa chỉ (Khách hàng)": f"SYN-CUSTOMER-ADDRESS-{customer_number:03d}",
        "Khu vực (Khách hàng)": "SYN-REGION",
        "Phường/Xã (Khách hàng)": "SYN-WARD",
        "Ngày sinh": "",
        "Bảng giá": "SYN-PRICE-LIST",
        "Người bán": "SYN-SELLER",
        "Kênh bán": "SYN-CHANNEL",
        "Người tạo": "SYN-FIXTURE-GENERATOR",
        "Đối tác giao hàng": "SYN-CARRIER",
        "Người nhận": f"SYN-RECEIVER-{customer_number:03d}",
        "Điện thoại (Người nhận)": f"SYN-RECEIVER-PHONE-{customer_number:03d}",
        "Địa chỉ (Người nhận)": f"SYN-RECEIVER-ADDRESS-{customer_number:03d}",
        "Khu vực (Người nhận)": "SYN-REGION",
        "Phường/Xã (Người nhận)": "SYN-WARD",
        "Dịch vụ": "SYN-DELIVERY-SERVICE",
        "Trọng lượng (gram)": 1000 + (index % 100),
        "Dài": 10,
        "Rộng": 10,
        "Cao": 10,
        "Ghi chú trạng thái giao hàng": "SYN-DELIVERY-STATUS-NOTE",
        "Ghi chú giao hàng": "SYN-DELIVERY-NOTE",
        "Ghi chú": "SYN-SAMPLE-NOTE",
        "Tổng tiền hàng": total - discount,
        "Giảm giá hóa đơn": 0,
        "VAT": 0,
        "Thu khác": 0,
        "Khách cần trả": total - discount,
        "Khách đã trả": 0,
        "Tiền mặt": 0,
        "Thẻ": 0,
        "Ví": 0,
        "Chuyển khoản": 0,
        "Còn cần thu (COD)": total - discount,
        "Thời gian giao hàng": timestamp + timedelta(days=1),
        "Trạng thái": "SYN-ORDER-STATUS",
        "Trạng thái giao hàng": "SYN-DELIVERY-STATUS",
        "Mã hàng": f"SYN-ITEM-{item_number:03d}",
        "Mã vạch": f"SYN-BARCODE-{item_number:03d}",
        "Tên hàng": f"SYN-ITEM-NAME-{item_number:03d}",
        "Thương hiệu": "SYN-BRAND",
        "ĐVT": unit,
        "Lô": f"SYN-LOT-{item_number:03d}",
        "Hạn sử dụng": datetime(2030, 1, 1),
        "Ghi chú hàng hóa": "SYN-ITEM-NOTE",
        "Số lượng": quantity,
        "Đơn giá": unit_price,
        "Giảm giá %": 0,
        "Giảm giá": discount,
        "Giá bán": unit_price,
        "Thành tiền": total - discount,
        "Column1": discount,
    }
    return [values[header] for header in RAW_HEADERS]


def build_raw_sales_fixture_bytes() -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "SYN-SALES"
    sheet.append(RAW_HEADERS)
    for index in range(1, ROW_COUNT + 1):
        sheet.append(_synthetic_row(index))
    workbook.properties.creator = "SYN-FIXTURE-GENERATOR"
    workbook.properties.lastModifiedBy = "SYN-FIXTURE-GENERATOR"
    workbook.properties.created = FIXED_TIMESTAMP
    workbook.properties.modified = FIXED_TIMESTAMP
    workbook.calculation.fullCalcOnLoad = False
    workbook.calculation.forceFullCalc = False

    generated = BytesIO()
    workbook.save(generated)
    return _canonicalize_xlsx(generated.getvalue())


def _canonicalize_xlsx(contents: bytes) -> bytes:
    source = ZipFile(BytesIO(contents), "r")
    output = BytesIO()
    with source, ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as target:
        for source_info in sorted(source.infolist(), key=lambda item: item.filename):
            info = ZipInfo(source_info.filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 0
            info.external_attr = 0
            payload = source.read(source_info.filename)
            if source_info.filename == "docProps/core.xml":
                payload = _canonicalize_core_properties(payload)
            target.writestr(info, payload)
    return output.getvalue()


def _canonicalize_core_properties(payload: bytes) -> bytes:
    root = ElementTree.fromstring(payload)
    namespace = "http://purl.org/dc/terms/"
    for property_name in ("created", "modified"):
        element = root.find(f"{{{namespace}}}{property_name}")
        if element is not None:
            element.text = "2000-01-01T00:00:00Z"
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=False)


def generate_fixtures(output_dir: Path, manifest_path: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_path = output_dir / "raw_sales_sample.xlsx"
    golden_path = output_dir / "golden_sales_import.xls"
    raw_path.write_bytes(build_raw_sales_fixture_bytes())

    report = convert_file(
        raw_path,
        "bsn_sales",
        golden_path,
        {"allow_calculation_warnings": True},
    )
    if not report.ok or not golden_path.exists():
        raise RuntimeError("Synthetic fixture conversion failed")
    scrub_ole_metadata_copy(golden_path, golden_path)

    template = get_misa_template("bsn_sales")
    manifest = {
        "schema_version": 2,
        "fixture_version": "2026-08-01.1",
        "fixtures": {
            "golden_sales_import.xls": {
                "sha256": _sha256(golden_path),
                "source_kind": "deterministic_synthetic",
                "fixture_kind": "synthetic",
                "privacy_classification": "synthetic_no_customer_data",
                "contains_customer_data": False,
                "generator": "scripts/generate_synthetic_sales_fixtures.py",
                "reviewer": "fixture-privacy-reviewer",
                "approval_status": "approved",
                "approved_at_utc": "2026-08-01T00:00:00+00:00",
                "synthetic_fixture_id": "synthetic-sales-golden-001",
                "path": "converter/fixtures/samples/golden_sales_import.xls",
                "derived_from": "raw_sales_sample.xlsx",
                "target_template_id": "bsn_sales",
                "template_sha256": template.sha256,
            },
            "raw_sales_sample.xlsx": {
                "sha256": _sha256(raw_path),
                "source_kind": "deterministic_synthetic",
                "fixture_kind": "synthetic",
                "privacy_classification": "synthetic_no_customer_data",
                "contains_customer_data": False,
                "generator": "scripts/generate_synthetic_sales_fixtures.py",
                "reviewer": "fixture-privacy-reviewer",
                "approval_status": "approved",
                "approved_at_utc": "2026-08-01T00:00:00+00:00",
                "synthetic_fixture_id": "synthetic-sales-raw-001",
                "path": "converter/fixtures/samples/raw_sales_sample.xlsx",
                "row_count": ROW_COUNT,
                "column_count": len(RAW_HEADERS),
            },
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate deterministic, synthetic converter sales fixtures."
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    manifest = generate_fixtures(args.output_dir, args.manifest)
    print(json.dumps(manifest, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
