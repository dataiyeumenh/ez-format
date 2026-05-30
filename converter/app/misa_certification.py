from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MISA_IMPORT_SOURCE_URLS = [
    "https://helpamis.misa.vn/kb/nhap-khau/",
    "https://helpamis.misa.vn/amis-mua-hang/kb/copy-du-lieu-tu-excel-vao-chung-tu/",
    "https://www.misa.vn/154745/tai-lieu-open-api-tich-hop-amis-ke-toan-doanh-nghiep/",
]


def create_manual_certification_record(
    *,
    conversion_type: str,
    output_path: Path,
    artifact_dir: Path,
    status: str = "pending_manual_import",
    notes: str | None = None,
) -> Path:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "conversion_type": conversion_type,
        "output_path": str(output_path),
        "status": status,
        "production_ready": status == "misa_import_passed",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_urls": MISA_IMPORT_SOURCE_URLS,
        "manual_steps": [
            "Import hoặc copy file output .xls vào MISA/AMIS sandbox đúng phân hệ.",
            "Chạy bước Kiểm tra dữ liệu của MISA/AMIS.",
            "Ghi lại lỗi MISA trả về, ảnh chụp hoặc export log nếu có.",
            "Nếu MISA import pass, đổi status thành misa_import_passed.",
            "Nếu MISA báo lỗi, thêm lỗi đó vào regression test trước khi sửa engine.",
        ],
        "notes": notes or (
            "MVP chưa có credential MISA Open API; record này là evidence stub cho manual import."
        ),
    }
    record_path = artifact_dir / f"{conversion_type}_misa_certification.json"
    record_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return record_path
