const { forwardMultipart } = require("./converterGatewayService");

async function parseMasterDataFile({
  file,
  catalogType,
  contextToken,
  requestId,
}) {
  const result = await forwardMultipart({
    path: "/api/v1/master-data/parse",
    file,
    fields: { catalog_type: catalogType },
    contextToken,
    requestId,
  });
  if (result.status >= 400) {
    const detail =
      [result.data?.detail, result.data?.message].find(
        (value) => typeof value === "string" && value.trim(),
      ) || `HTTP ${result.status}`;
    throw new Error(`Converter không đọc được danh mục MISA: ${detail}`);
  }
  return result.data;
}

module.exports = { parseMasterDataFile };
