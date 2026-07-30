from app.mapping_semantics import validate_mapping_semantics


def test_commune_column_cannot_map_to_sales_form_enum():
    issues = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=["Hình thức bán hàng", "Mã hàng (*)"],
        source_headers=["Phường/Xã (Khách hàng)"],
        mapping={"Phường/Xã (Khách hàng)": "Hình thức bán hàng"},
        defaults={},
        formulas={},
        sample_rows=[{"Phường/Xã (Khách hàng)": "Phường 1"}],
    )
    assert any(
        issue.code == "mapping_domain_mismatch" and issue.severity == "blocker"
        for issue in issues
    )


def test_unknown_account_is_warning_without_loaded_coa():
    issues = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=["TK Tiền/Chi phí/Nợ (*)"],
        source_headers=["Tài khoản"],
        mapping={"Tài khoản": "TK Tiền/Chi phí/Nợ (*)"},
        defaults={},
        formulas={},
        sample_rows=[{"Tài khoản": "999"}],
    )
    assert any(issue.code == "account_master_data_unavailable" for issue in issues)
    assert all(issue.severity == "warning" for issue in issues)


def test_unknown_account_is_blocker_when_loaded_coa_proves_invalid():
    issues = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=["TK Tiền/Chi phí/Nợ (*)"],
        source_headers=["Tài khoản"],
        mapping={"Tài khoản": "TK Tiền/Chi phí/Nợ (*)"},
        defaults={},
        formulas={},
        sample_rows=[{"Tài khoản": "999"}],
        coa_codes={"131"},
    )
    assert any(
        issue.code == "account_code_not_in_coa" and issue.severity == "blocker"
        for issue in issues
    )


def test_missing_required_mapping_is_deterministic_blocker():
    issues = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=["Mã hàng (*)"],
        source_headers=["Tên hàng"],
        mapping={},
        defaults={},
        formulas={},
        sample_rows=[{"Tên hàng": "Hàng hóa"}],
    )
    assert any(
        issue.code == "required_mapping_missing" and issue.severity == "blocker"
        for issue in issues
    )


def test_valid_sales_mapping_has_no_domain_errors():
    issues = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=["Hình thức bán hàng", "Mã hàng (*)", "Số lượng"],
        source_headers=["Loại bán", "Mã hàng", "Số lượng"],
        mapping={
            "Loại bán": "Hình thức bán hàng",
            "Mã hàng": "Mã hàng (*)",
            "Số lượng": "Số lượng",
        },
        defaults={},
        formulas={},
        sample_rows=[
            {"Loại bán": "Bán hàng hóa trong nước", "Mã hàng": "SP01", "Số lượng": 1}
        ],
    )
    assert not any(issue.code == "mapping_domain_mismatch" for issue in issues)
