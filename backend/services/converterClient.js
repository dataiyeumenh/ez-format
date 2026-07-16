function converterBaseUrl() {
  return String(
    process.env.CONVERTER_INTERNAL_URL ||
      process.env.PYTHON_API_URL ||
      process.env.CONVERTER_URL ||
      "http://127.0.0.1:8000",
  ).replace(/\/+$/, "");
}

async function parseMasterDataFile({ file, catalogType }) {
  const form = new FormData();
  form.append("catalog_type", catalogType);
  form.append(
    "file",
    new Blob([file.buffer], {
      type: file.mimetype || "application/octet-stream",
    }),
    file.originalname,
  );

  const response = await fetch(
    `${converterBaseUrl()}/api/v1/master-data/parse`,
    {
      method: "POST",
      headers: process.env.CONVERTER_SERVICE_TOKEN
        ? { "x-converter-service-token": process.env.CONVERTER_SERVICE_TOKEN }
        : {},
      body: form,
      signal: AbortSignal.timeout(
        Number(process.env.CONVERTER_TIMEOUT_MS || 60000),
      ),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload.detail || payload.message || `HTTP ${response.status}`;
    throw new Error(`Converter không đọc được danh mục MISA: ${detail}`);
  }
  return payload;
}

module.exports = { parseMasterDataFile };
