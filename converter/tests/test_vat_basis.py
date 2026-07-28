from app.vat_basis import validate_vat_basis


def test_vat_matches_selected_discount_basis():
    result = validate_vat_basis(
        "line_after_discount", taxable_base="100000", vat_rate="0.1", vat="10000"
    )
    assert result.ok is True


def test_vat_mismatch_is_blocker():
    result = validate_vat_basis(
        "line_after_discount", taxable_base="100000", vat_rate="0.1", vat="10002"
    )
    assert result.severity == "blocker"


def test_vat_basis_ambiguity_requires_acknowledgement():
    result = validate_vat_basis("unknown")
    assert result.severity == "warning"


def test_vat_8_eligibility_remains_review_warning():
    result = validate_vat_basis(
        "line_after_discount", taxable_base="100000", vat_rate="0.08", vat="8000"
    )
    assert result.ok is True
    assert result.severity == "warning"
