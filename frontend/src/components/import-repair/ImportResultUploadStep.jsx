import { FileUp, Loader2 } from "lucide-react";
import { useState } from "react";

const ImportResultUploadStep = ({ disabled, loading, onSubmit, runId }) => {
  const [file, setFile] = useState(null);
  const handleSubmit = (event) => {
    event.preventDefault();
    if (file) onSubmit(file);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-describedby="repair-upload-help">
      <div className="rounded-xl border border-dashed border-cyan-200 bg-cyan-50/70 p-4 sm:p-5">
        <p className="text-sm font-bold text-slate-900">File kết quả import từ MISA</p>
        <p id="repair-upload-help" className="mt-1 text-sm leading-6 text-slate-600">
          Chọn file lỗi MISA vừa tải xuống. EzFormat chỉ dùng thông tin lỗi để ghép và sửa;
          không hiển thị bảng tính thô.
        </p>
        <input
          id="import-result-file"
          name="importResult"
          type="file"
          accept=".xls,.xlsx"
          disabled={disabled || loading || !runId}
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
        <label htmlFor="import-result-file" className="btn-secondary mt-4 min-h-11 cursor-pointer">
          <FileUp size={16} />Chọn file lỗi MISA
        </label>
        <p className="mt-2 text-xs text-slate-600" aria-live="polite">
          {file ? `Đã chọn: ${file.name}` : "Chưa chọn file lỗi."}
        </p>
      </div>
      <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={disabled || loading || !runId || !file}>
        {loading ? <Loader2 size={17} className="animate-spin" /> : <FileUp size={17} />}
        Phân tích file lỗi
      </button>
    </form>
  );
};

export default ImportResultUploadStep;
