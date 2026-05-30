from app.normalization import normalize_header, normalize_record_keys


def test_normalize_header_handles_vietnamese_accents_and_symbols():
    assert normalize_header("Mã hóa đơn") == "ma_hoa_don"
    assert normalize_header("Giảm giá %") == "giam_gia_percent"
    assert normalize_header("Địa chỉ (Khách hàng)") == "dia_chi_khach_hang"


def test_normalize_record_keys_keeps_original_values():
    normalized = normalize_record_keys({"Mã hóa đơn": "HD001", "Số lượng": 2})

    assert normalized == {"ma_hoa_don": "HD001", "so_luong": 2}
