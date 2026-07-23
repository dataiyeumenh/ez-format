from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from app.misa_templates import get_misa_template
from app.normalization import normalize_header


DICTIONARY_VERSION = "student-field-dictionary-v1"
CHECKED_AT = "2026-07-17"
MISA_IMPORT_SOURCE_URL = "https://helpact.misa.vn/kb/html_10050000/"


def _definition(
    title: str,
    meaning_vi: str,
    aliases: list[str],
    mistakes: list[str],
    fix_hint_vi: str,
) -> dict[str, Any]:
    return {
        "title": title,
        "meaning_vi": meaning_vi,
        "aliases": aliases,
        "common_mistakes": mistakes,
        "fix_hint_vi": fix_hint_vi,
    }


CRITICAL_DEFINITIONS = {
    "ngay_hach_toan": _definition(
        "Ngày hạch toán",
        "Ngày nghiệp vụ được ghi nhận vào sổ kế toán trong dữ liệu đích.",
        ["ngày ghi sổ", "posting date", "ngayct"],
        ["Nhầm với ngày hóa đơn", "Dùng giá trị không phải ngày"],
        "Đối chiếu ngày ghi nhận nghiệp vụ với chứng từ nguồn và yêu cầu bài làm.",
    ),
    "ngay_chung_tu": _definition(
        "Ngày chứng từ",
        "Ngày được ghi trên chứng từ dùng làm căn cứ cho dòng dữ liệu.",
        ["document date", "ngày phiếu", "ngayct"],
        ["Nhầm với ngày hạch toán", "Mất phần ngày do định dạng Excel"],
        "Chọn cột ngày chứng từ thực tế và kiểm tra định dạng ngày trước khi import.",
    ),
    "so_chung_tu": _definition(
        "Số chứng từ",
        "Mã nhận diện chứng từ, thường được dùng để theo dõi và nhóm các dòng cùng chứng từ.",
        ["số phiếu", "document number", "soct", "mã hóa đơn"],
        ["Mất số 0 ở đầu", "Dùng số hóa đơn thay cho số chứng từ nội bộ"],
        "Giữ trường này ở dạng văn bản và đối chiếu khóa chứng từ trong file nguồn.",
    ),
    "so_phieu_nhap": _definition(
        "Số phiếu nhập",
        "Mã nhận diện phiếu nhập dùng để theo dõi các dòng của cùng nghiệp vụ mua hàng.",
        ["số chứng từ", "receipt number", "soct"],
        ["Mất số 0 ở đầu", "Trùng số nhưng khác ngày hoặc nhà cung cấp"],
        "Giữ nguyên mã phiếu từ nguồn và kiểm tra các dòng cùng phiếu có thông tin nhất quán.",
    ),
    "ma_hang": _definition(
        "Mã hàng",
        "Mã định danh hàng hóa trong dòng nghiệp vụ và danh mục đích.",
        ["mã vật tư", "item code", "sku", "mathang"],
        ["Dùng tên hàng thay cho mã", "Mất số 0 ở đầu", "Mã chưa có trong danh mục"],
        "Ưu tiên cột mã hàng; nếu nguồn chỉ có tên hàng thì cần rà soát lại danh mục trước import.",
    ),
    "ma_dich_vu": _definition(
        "Mã dịch vụ",
        "Mã định danh dịch vụ trong dòng nghiệp vụ và danh mục đích.",
        ["service code", "mã nội dung dịch vụ"],
        ["Dùng tên dịch vụ thay cho mã", "Mã chưa có trong danh mục"],
        "Chọn cột mã dịch vụ và xác minh mã tồn tại trong danh mục sử dụng.",
    ),
    "tk_tien_chi_phi_no": _definition(
        "Tài khoản Nợ",
        "Tài khoản nhận giá trị bên Nợ cho dòng bán hàng theo cấu hình của chứng từ.",
        ["tài khoản nợ", "debit account", "tk nợ"],
        ["Nhập tên tài khoản thay vì mã", "Tự suy đoán tài khoản khi thiếu căn cứ"],
        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp; không tự suy đoán.",
    ),
    "tk_doanh_thu_co": _definition(
        "Tài khoản doanh thu/Có",
        "Tài khoản nhận giá trị bên Có cho doanh thu của dòng bán hàng.",
        ["tài khoản có", "revenue account", "tk doanh thu"],
        ["Nhập tên tài khoản thay vì mã", "Dùng một tài khoản cho mọi loại nghiệp vụ"],
        "Đối chiếu mã tài khoản với nội dung nghiệp vụ và yêu cầu bài làm trước import.",
    ),
    "tk_kho_tk_chi_phi": _definition(
        "Tài khoản kho/chi phí",
        "Tài khoản ghi nhận giá trị hàng mua vào kho hoặc chi phí của dòng mua hàng.",
        ["tài khoản nợ", "inventory account", "expense account", "tk kho"],
        ["Không phân biệt hàng hóa và dịch vụ", "Tự suy đoán tài khoản từ tên hàng"],
        "Rà soát loại nghiệp vụ và mã tài khoản được yêu cầu; giữ trạng thái cần xem xét khi thiếu căn cứ.",
    ),
    "tk_cong_no_tk_tien": _definition(
        "Tài khoản công nợ/tiền",
        "Tài khoản đối ứng phản ánh công nợ nhà cung cấp hoặc khoản tiền đã thanh toán.",
        ["tài khoản có", "payable account", "cash account", "tk công nợ"],
        ["Không khớp phương thức thanh toán", "Tự suy đoán tài khoản từ tên nhà cung cấp"],
        "Đối chiếu phương thức thanh toán và yêu cầu bài làm trước khi chọn mã tài khoản.",
    ),
    "so_hoa_don": _definition(
        "Số hóa đơn",
        "Số nhận diện hóa đơn được ghi trong dữ liệu nguồn.",
        ["invoice number", "so_hd", "số HĐ"],
        ["Mất số 0 ở đầu", "Nhầm với số chứng từ nội bộ"],
        "Giữ dạng văn bản và đối chiếu trực tiếp với hóa đơn hoặc file nguồn.",
    ),
    "ngay_hoa_don": _definition(
        "Ngày hóa đơn",
        "Ngày được ghi trên hóa đơn liên quan đến nghiệp vụ.",
        ["invoice date", "ngay_hd"],
        ["Nhầm với ngày hạch toán", "Định dạng ngày không đọc được"],
        "Đối chiếu ngày trên hóa đơn và giữ riêng với ngày hạch toán khi hai ngày khác nhau.",
    ),
    "ma_so_thue": _definition(
        "Mã số thuế",
        "Mã định danh thuế của khách hàng hoặc nhà cung cấp như được ghi trong dữ liệu nguồn.",
        ["tax code", "mst", "mã số thuế NCC"],
        ["Mất số 0 ở đầu", "Gắn nhầm mã cho đối tượng khác"],
        "Giữ dạng văn bản và đối chiếu với đúng đối tượng trong chứng từ nguồn.",
    ),
    "so_luong": _definition(
        "Số lượng",
        "Số lượng hàng hóa hoặc dịch vụ của dòng chi tiết.",
        ["quantity", "qty", "luong"],
        ["Dùng chuỗi có kèm đơn vị", "Nhầm dấu phân cách thập phân"],
        "Chọn cột số lượng dạng số và đối chiếu với đơn vị tính của cùng dòng.",
    ),
    "don_gia": _definition(
        "Đơn giá",
        "Giá cho một đơn vị hàng hóa hoặc dịch vụ của dòng chi tiết.",
        ["unit price", "price", "dgvnd"],
        ["Nhầm giá đã gồm thuế", "Nhầm dấu phân cách hàng nghìn"],
        "Đối chiếu cách tính thành tiền trong file nguồn trước khi dùng cột đơn giá.",
    ),
    "thanh_tien": _definition(
        "Thành tiền",
        "Giá trị tiền của dòng chi tiết trước các khoản được tách riêng trong mẫu.",
        ["amount", "line amount", "ttvnd"],
        ["Nhầm tổng thanh toán với thành tiền", "Sai do số lượng nhân đơn giá"],
        "Đối chiếu công thức của file nguồn và so sánh với số lượng, đơn giá khi các cột này có đủ.",
    ),
    "ty_le_ck": _definition(
        "Tỷ lệ chiết khấu",
        "Tỷ lệ chiết khấu áp dụng cho dòng chi tiết nếu nguồn có thông tin này.",
        ["discount rate", "% CK", "pt_ck"],
        ["Nhập 10 thay vì 10% theo định dạng nguồn", "Có tỷ lệ nhưng thiếu tiền chiết khấu"],
        "Kiểm tra cách biểu diễn phần trăm trong file nguồn và đối chiếu với tiền chiết khấu.",
    ),
    "tien_chiet_khau": _definition(
        "Tiền chiết khấu",
        "Số tiền chiết khấu của dòng chi tiết.",
        ["discount amount", "chiết khấu"],
        ["Nhầm với tỷ lệ chiết khấu", "Dấu âm/dương không nhất quán"],
        "Đối chiếu với tỷ lệ chiết khấu và thành tiền nếu nguồn cung cấp đủ dữ liệu.",
    ),
    "thue_gtgt": _definition(
        "Thuế suất GTGT",
        "Tỷ lệ thuế GTGT được ghi cho dòng dữ liệu; trường này chỉ phản ánh giá trị nguồn, không kết luận tính phù hợp pháp lý.",
        ["VAT rate", "thuế suất", "ts_gtgt"],
        ["Nhập phần trăm sai định dạng", "Tự chọn thuế suất khi nguồn không có"],
        "Giữ nguyên giá trị có căn cứ từ nguồn; nếu thiếu hoặc cần phán đoán thì đánh dấu cần rà soát.",
    ),
    "tien_thue_gtgt": _definition(
        "Tiền thuế GTGT",
        "Số tiền thuế GTGT được ghi cho dòng hoặc chứng từ.",
        ["VAT amount", "thuế GTGT", "thuevnd"],
        ["Nhầm với tổng thanh toán", "Không khớp thành tiền và thuế suất"],
        "Đối chiếu phép tính khi thành tiền và thuế suất đều có trong nguồn.",
    ),
    "tk_thue_gtgt": _definition(
        "Tài khoản thuế GTGT",
        "Mã tài khoản dùng cho phần thuế GTGT của dòng dữ liệu.",
        ["VAT account", "tk thuế", "tkthue"],
        ["Nhập tên thay vì mã tài khoản", "Tự suy đoán khi thiếu ngữ cảnh"],
        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp; không tự suy đoán.",
    ),
    "loai_tien": _definition(
        "Loại tiền",
        "Mã đồng tiền áp dụng cho chứng từ hoặc dòng dữ liệu.",
        ["currency", "currency code"],
        ["Dùng tên tiền thay cho mã", "Thiếu tỷ giá khi nguồn cần quy đổi"],
        "Đối chiếu mã đồng tiền trong nguồn và kiểm tra tỷ giá khi không dùng đồng tiền hạch toán.",
    ),
    "ty_gia": _definition(
        "Tỷ giá",
        "Hệ số quy đổi giữa loại tiền của chứng từ và đồng tiền hạch toán.",
        ["exchange rate", "rate"],
        ["Nhầm chiều tỷ giá", "Nhập văn bản không phải số"],
        "Đối chiếu tỷ giá và cách quy đổi được sử dụng trong file nguồn.",
    ),
    "ma_khach_hang": _definition(
        "Mã khách hàng",
        "Mã định danh khách hàng trong danh mục đích.",
        ["customer code", "mã KH", "makh"],
        ["Dùng tên khách hàng thay cho mã", "Mã chưa được xác minh trong danh mục"],
        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
    ),
    "ma_nha_cung_cap": _definition(
        "Mã nhà cung cấp",
        "Mã định danh nhà cung cấp trong danh mục đích.",
        ["supplier code", "vendor code", "mã NCC"],
        ["Dùng tên nhà cung cấp thay cho mã", "Mã chưa được xác minh trong danh mục"],
        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
    ),
    "ma_ncc": _definition(
        "Mã nhà cung cấp",
        "Mã định danh nhà cung cấp trong danh mục đích.",
        ["supplier code", "vendor code", "mã nhà cung cấp"],
        ["Dùng tên nhà cung cấp thay cho mã", "Mã chưa được xác minh trong danh mục"],
        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
    ),
    "ma_kho": _definition(
        "Mã kho",
        "Mã định danh kho liên quan đến dòng hàng hóa.",
        ["warehouse code", "kho"],
        ["Dùng tên kho thay cho mã", "Mã kho chưa được xác minh"],
        "Đối chiếu mã kho trong nguồn hoặc danh mục được chọn.",
    ),
    "tk_kho": _definition(
        "Tài khoản kho",
        "Mã tài khoản phản ánh giá trị hàng tồn kho của dòng dữ liệu.",
        ["inventory account", "tài khoản kho"],
        ["Nhập tên thay vì mã tài khoản", "Không khớp loại hàng hoặc kho"],
        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp.",
    ),
    "tk_gia_von": _definition(
        "Tài khoản giá vốn",
        "Mã tài khoản dùng cho giá vốn của dòng bán hàng khi nghiệp vụ có theo dõi giá vốn.",
        ["cost of goods sold account", "COGS account"],
        ["Nhập tên thay vì mã", "Tự suy đoán khi file nguồn không có căn cứ"],
        "Chỉ điền khi nguồn hoặc cấu hình nghiệp vụ có căn cứ; nếu không, để người dùng rà soát.",
    ),
    "don_gia_von": _definition(
        "Đơn giá vốn",
        "Giá vốn cho một đơn vị hàng hóa của dòng bán hàng.",
        ["unit cost", "cost price"],
        ["Nhầm với đơn giá bán", "Tự tính khi thiếu dữ liệu nguồn"],
        "Đối chiếu với dữ liệu giá vốn có sẵn; không tự tạo giá trị khi nguồn không cung cấp.",
    ),
    "tien_von": _definition(
        "Tiền vốn",
        "Tổng giá vốn của dòng bán hàng.",
        ["cost amount", "COGS amount"],
        ["Nhầm với thành tiền bán", "Không khớp số lượng và đơn giá vốn"],
        "Đối chiếu với dữ liệu giá vốn nguồn và phép tính khi đủ số lượng, đơn giá vốn.",
    ),
}


KEY_ALIASES = {
    normalize_header("Số chứng từ (*)"): "so_chung_tu",
    normalize_header("Số phiếu nhập (*)"): "so_phieu_nhap",
    normalize_header("Mã hàng (*)"): "ma_hang",
    normalize_header("Mã dịch vụ (*)"): "ma_dich_vu",
    normalize_header("TK Tiền/Chi phí/Nợ (*)"): "tk_tien_chi_phi_no",
    normalize_header("TK Doanh thu/Có (*)"): "tk_doanh_thu_co",
    normalize_header("TK kho/TK chi phí (*)"): "tk_kho_tk_chi_phi",
    normalize_header("TK công nợ/TK tiền (*)"): "tk_cong_no_tk_tien",
    normalize_header("% thuế GTGT"): "thue_gtgt",
}


def field_definition(template_id: str, header: str) -> dict[str, Any]:
    template = get_misa_template(str(template_id or "").strip())
    clean_header = str(header or "").strip()
    if not clean_header:
        raise ValueError("Student field header là bắt buộc")

    required = "(*)" in clean_header
    in_template = clean_header in template.headers
    normalized = normalize_header(re.sub(r"\s*\(\*\)\s*", "", clean_header))
    definition_key = KEY_ALIASES.get(normalize_header(clean_header), normalized)
    definition = CRITICAL_DEFINITIONS.get(definition_key)
    specific = definition is not None
    if definition is None:
        definition = _definition(
            clean_header,
            (
                f"Trường tùy chọn '{clean_header}' trong mẫu {template.id}; trường này chỉ "
                "mang giá trị cùng tên từ file nguồn khi dữ liệu phù hợp."
            ),
            [clean_header],
            ["Gán cột nguồn chỉ vì tên gần giống", "Tạo giá trị khi file nguồn không có căn cứ"],
            "Đối chiếu theo tên cột và dữ liệu nguồn; để trống nếu không có căn cứ phù hợp.",
        )

    payload = deepcopy(definition)
    payload.update(
        {
            "template_id": template.id,
            "header": clean_header,
            "required": required,
            "required_source": (
                "template_marker" if required else "not_required_by_template_marker"
            ),
            "specific": specific,
            "source": {
                "rule_id": (
                    "student_field_definition_specific_v1"
                    if specific
                    else "student_optional_field_safe_fallback_v1"
                ),
                "source_ref": (
                    f"template:{template.id}:{clean_header}"
                    if in_template
                    else f"header:{template.id}:{clean_header}"
                ),
                "source_url": MISA_IMPORT_SOURCE_URL if specific and in_template else None,
                "checked_at": CHECKED_AT,
                "effective_from": None,
                "effective_to": None,
                "dictionary_version": DICTIONARY_VERSION,
            },
        }
    )
    return payload
