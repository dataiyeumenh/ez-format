import json
from pathlib import Path

from app.misa_certification import create_manual_certification_record


def test_manual_misa_certification_record_is_pending_and_source_backed(tmp_path):
    output_file = tmp_path / "sales_goods.xls"
    output_file.write_bytes(b"fake xls bytes")

    record_path = create_manual_certification_record(
        conversion_type="sales_goods",
        output_path=output_file,
        artifact_dir=tmp_path,
    )

    payload = json.loads(record_path.read_text(encoding="utf-8"))
    assert payload["status"] == "pending_manual_import"
    assert payload["conversion_type"] == "sales_goods"
    assert payload["output_path"] == str(output_file)
    assert payload["production_ready"] is False
    assert payload["source_urls"]
    assert payload["manual_steps"]
