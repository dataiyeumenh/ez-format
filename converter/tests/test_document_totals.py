from app.document_totals import aggregate_document_totals


def test_two_detail_rows_with_same_invoice_total_count_once():
    report = aggregate_document_totals(
        [
            {"SOCT": "HD001", "TTVND": "108000"},
            {"SOCT": "HD001", "TTVND": "108000"},
        ],
        document_key_fields=["SOCT"],
        line_amount_field=None,
        document_total_field="TTVND",
    )
    assert report.sum_total == "108000"
    assert report.document_count == 1
    assert report.status == "complete"


def test_line_amounts_sum_each_detail_row():
    report = aggregate_document_totals(
        [
            {"SOCT": "HD001", "LINE": "1000"},
            {"SOCT": "HD001", "LINE": "2000"},
        ],
        document_key_fields=["SOCT"],
        line_amount_field="LINE",
        document_total_field=None,
    )
    assert report.sum_total == "3000"
    assert report.document_count == 1


def test_missing_document_key_never_fabricates_total():
    report = aggregate_document_totals(
        [{"SOCT": "", "TTVND": "108000"}],
        document_key_fields=["SOCT"],
        line_amount_field=None,
        document_total_field="TTVND",
    )
    assert report.status == "needs_review"
    assert report.sum_total is None
    assert "missing_document_key" in report.issues


def test_conflicting_repeated_document_total_blocks():
    report = aggregate_document_totals(
        [
            {"SOCT": "HD001", "TTVND": "108000"},
            {"SOCT": "HD001", "TTVND": "109000"},
        ],
        document_key_fields=["SOCT"],
        line_amount_field=None,
        document_total_field="TTVND",
    )
    assert report.status == "blocked"
    assert "conflicting_document_total" in report.issues
