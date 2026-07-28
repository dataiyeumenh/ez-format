from app.ai_gateway import _build_prompt


def test_purchase_prompt_includes_accounting_context_and_redacted_samples():
    prompt = _build_prompt(
        {
            "target_template": {
                "id": "misa_purchase_domestic",
                "headers": [
                    "Hình thức mua hàng",
                    "Ngày hạch toán (*)",
                    "Số phiếu nhập (*)",
                    "Mã hàng (*)",
                    "Thành tiền",
                ],
            },
            "source": {
                "sheet_name": "Smart_KTSC_OK",
                "headers": ["LOAI_MUA", "NGAYCT", "SOCT", "MA_VTHH", "TTVND"],
                "sample_rows": [
                    {
                        "LOAI_MUA": "Dịch vụ",
                        "NGAYCT": "2026-04-02",
                        "SOCT": "PN001",
                        "MA_VTHH": "DV001",
                        "TTVND": 2_905_880,
                    }
                ],
            },
            "nearby_profiles": [],
        }
    )

    assert "ACCOUNTING_MAPPING_CONTEXT" in prompt
    assert "do_not_invent_codes" in prompt
    assert '"alias_profile": "accounting_codes"' in prompt
    assert '"LOAI_MUA": "dich_vu"' in prompt
    assert '"NGAYCT": "<date>"' in prompt
    assert '"TTVND": "<number>"' in prompt
    assert "Dịch vụ" not in prompt
    assert "PN001" not in prompt
    assert "DV001" not in prompt
    assert "2905880" not in prompt
    assert len(prompt) < 30_000


def test_sales_prompt_does_not_include_purchase_knowledge_pack():
    prompt = _build_prompt(
        {
            "target_template": {"id": "bsn_sales", "headers": ["Số chứng từ (*)"]},
            "source": {
                "sheet_name": "BanHang",
                "headers": ["Mã hóa đơn"],
                "sample_rows": [{"Mã hóa đơn": "HD001"}],
            },
            "nearby_profiles": [],
        }
    )

    assert "ACCOUNTING_MAPPING_CONTEXT" not in prompt
    assert len(prompt) < 10_000
