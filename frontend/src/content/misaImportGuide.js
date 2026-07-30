export const MISA_IMPORT_GUIDE = [
  {
    id: "choose-document-type",
    title: "Chọn loại chứng từ",
    why: "Mỗi loại chứng từ dùng mẫu import và trường bắt buộc khác nhau.",
    action: "Chọn đúng mẫu MISA trước khi tải file nguồn lên EzFormat.",
    unsure: "Nếu chưa chắc, hỏi kế toán phụ trách loại nghiệp vụ trước khi tiếp tục.",
  },
  {
    id: "upload-raw",
    title: "Tải file nguồn",
    why: "EzFormat cần dữ liệu gốc để tạo các liên kết kiểm tra được.",
    action: "Chỉ tải file dữ liệu bạn được phép xử lý.",
    unsure: "Bắt đầu với một bản sao hoặc dữ liệu mẫu, không dùng sổ thật.",
  },
  {
    id: "review-mapping",
    title: "Rà ghép cột",
    why: "Ghép cột quyết định dữ liệu nào đi vào từng trường MISA.",
    action: "Xác nhận các cột bắt buộc và giá trị mặc định.",
    unsure: "Để trống trường chưa rõ, quay lại hỏi người lập chứng từ.",
  },
  {
    id: "validate",
    title: "Kiểm tra lỗi",
    why: "Cảnh báo sớm giúp tránh xuất file thiếu dữ liệu bắt buộc.",
    action: "Sửa blocker, đọc kỹ cảnh báo và xác nhận khi đã kiểm tra.",
    unsure: "Tải bản xem trước, đối chiếu một vài chứng từ với file nguồn.",
  },
  {
    id: "download-misa",
    title: "Tải file MISA",
    why: "File xuất là đầu vào để bạn chủ động nhập vào MISA.",
    action: "Lưu file ở vị trí dễ nhận biết và không sửa cấu trúc cột.",
    unsure: "Giữ bản xuất nguyên vẹn để đối chiếu nếu MISA báo lỗi.",
  },
  {
    id: "import-in-misa",
    title: "Nhập trong MISA",
    why: "MISA xác thực quy tắc cuối cùng của phần mềm và dữ liệu doanh nghiệp.",
    action: "Dùng chức năng nhập khẩu của MISA cho đúng loại chứng từ.",
    unsure: "Dừng lại nếu loại chứng từ hoặc kỳ hạch toán không khớp.",
  },
  {
    id: "download-error-file",
    title: "Tải file lỗi",
    why: "File lỗi là bằng chứng MISA trả về cho từng dòng cần xử lý.",
    action: "Tải file kết quả/lỗi do MISA tạo ra, không sửa tay trước khi tải lên.",
    unsure: "Nếu MISA không cho tải file lỗi, ghi lại thông báo và hỏi hỗ trợ MISA.",
  },
  {
    id: "upload-error-file",
    title: "Tải file lỗi lên EzFormat",
    why: "EzFormat dùng nội dung lỗi để ghép với chứng từ đã xuất.",
    action: "Chọn đúng conversion run rồi tải file lỗi MISA lên.",
    unsure: "Không tải file Excel khác; hãy quay lại bước tải file lỗi từ MISA.",
  },
  {
    id: "confirm-and-retry",
    title: "Xác nhận và xuất lại",
    why: "Chỉ chứng từ đã được người dùng xác nhận mới được xuất lại.",
    action: "Xác nhận trạng thái import, sửa lỗi và chỉ chọn chứng từ thất bại.",
    unsure: "Giữ retry bị khóa cho đến khi mọi lỗi và cảnh báo đã rõ ràng.",
  },
];

export const MISA_IMPORT_OFFICIAL_LINKS = [
  { label: "Trung tâm trợ giúp MISA AMIS", href: "https://help.amis.vn/" },
  { label: "Trung tâm trợ giúp MISA", href: "https://help.misa.vn/" },
];
