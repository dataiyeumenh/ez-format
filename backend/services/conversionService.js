const { CONVERSION_TYPES } = require("../config/conversionTypes");
const { readExcelBuffer } = require("../utils/excelReader");

function getConversionTypes() {
  return Object.values(CONVERSION_TYPES).map((definition) => ({
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
  }));
}

function getConversionType(conversionType) {
  const definition = CONVERSION_TYPES[conversionType];
  if (!definition) {
    throw new Error(`Unsupported conversion_type: ${conversionType}`);
  }
  return definition;
}

function buildValidationReport() {
  return {
    ok: true,
    issues: [],
  };
}

module.exports = {
  getConversionTypes,
  getConversionType,
  buildValidationReport,
};
