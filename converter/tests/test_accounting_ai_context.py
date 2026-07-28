import json

from app.accounting_ai_context import build_accounting_mapping_context
from app.misa_mapping import MappingSuggestion, normalize_ai_suggestion
from app.misa_templates import get_misa_template


def test_purchase_context_selects_nearest_accounting_code_examples():
    context = build_accounting_mapping_context(
        target_template_id="misa_purchase_domestic",
        source_headers=["SOCT", "NGAYCT", "MADTPNCO", "MATHANG", "TTVND", "TS_GTGT"],
        target_headers=["Số phiếu nhập (*)", "Ngày hạch toán (*)", "Mã hàng (*)"],
    )

    assert 1 <= len(context["few_shot_examples"]) <= 6
    assert context["few_shot_examples"][0]["alias_profile"] == "accounting_codes"
    assert context["required_field_policy"] == "template_headers_with_(*)_are_required"
    assert "do_not_invent_codes" in context["safety_rules"]
    assert "account_review_required" in context["review_rules"]


def test_purchase_context_is_compact_and_contains_only_synthetic_examples():
    context = build_accounting_mapping_context(
        target_template_id="misa_purchase_domestic",
        source_headers=[f"Unknown {index}" for index in range(200)],
        target_headers=[f"MISA {index}" for index in range(100)],
    )
    encoded = json.dumps(context, ensure_ascii=False)

    assert len(encoded) <= 12_000
    assert "synthetic" in encoded.lower()
    assert "BAE" not in encoded
    assert "0300951119-005" not in encoded


def test_non_purchase_target_does_not_receive_purchase_context():
    assert build_accounting_mapping_context(
        target_template_id="bsn_sales",
        source_headers=["Mã hóa đơn"],
        target_headers=["Số chứng từ (*)"],
    ) == {}


def test_ai_merge_keeps_account_fields_for_manual_review():
    template = get_misa_template("misa_purchase_domestic")
    fallback = MappingSuggestion(
        source="heuristic",
        confidence=0.4,
        mapping={},
        defaults={
            "Phương thức thanh toán": "Chưa thanh toán",
            "TK công nợ/TK tiền (*)": "331",
        },
        formulas={},
        warnings=[
            "Thiếu mapping cho cột bắt buộc: Hình thức mua hàng, Ngày hạch toán (*)"
        ],
    )
    result = normalize_ai_suggestion(
        {
            "mapping": {
                "LOAI_MUA": ["Hình thức mua hàng", "TK kho/TK chi phí (*)"],
                "NGAYCT": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
                "SOCT": "Số phiếu nhập (*)",
                "MA_VTHH": "Mã hàng (*)",
            },
            "confidence": 0.8,
            "notes": [],
        },
        fallback,
        target_template_id="misa_purchase_domestic",
        target_headers=template.headers,
    )

    missing_warning = next(
        item for item in result.warnings if "Thiếu mapping cho cột bắt buộc" in item
    )
    assert "Hình thức mua hàng" not in missing_warning
    assert "Ngày hạch toán (*)" not in missing_warning
    assert "TK kho/TK chi phí (*)" in missing_warning
    assert "TK công nợ/TK tiền (*)" in missing_warning
