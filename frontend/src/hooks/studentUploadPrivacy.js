const SAFE_STUDENT_EXTENSIONS = new Set([".xls", ".xlsx"]);

export function studentUploadExtension(file) {
  const match = String(file?.name || "")
    .trim()
    .toLowerCase()
    .match(/(\.xlsx?)$/);
  return match && SAFE_STUDENT_EXTENSIONS.has(match[1]) ? match[1] : "";
}

export function studentUploadFilename(file) {
  return `student-upload${studentUploadExtension(file)}`;
}

export function studentUploadMetadata(file) {
  return {
    sizeBytes: Number(file?.size || 0),
    extension: studentUploadExtension(file),
    contentHash: "",
  };
}

export function appendStudentUpload(formData, file) {
  formData.append("file", file, studentUploadFilename(file));
}
