const INDEX_METADATA_OPTIONS = new Set([
  "background",
  "key",
  "name",
  "ns",
  "v",
]);
const DEFAULT_FALSE_OPTIONS = new Set(["hidden", "sparse", "unique"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function semanticIndexOptions(options = {}) {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key, value]) => (
        !INDEX_METADATA_OPTIONS.has(key)
        && !(DEFAULT_FALSE_OPTIONS.has(key) && value === false)
      ))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalize(value)]),
  );
}

function sameIndexKeys(actual = {}, expected = {}) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function indexMatchesContract(index = {}, spec = {}) {
  return sameIndexKeys(index.key, spec.keys)
    && JSON.stringify(semanticIndexOptions(index))
      === JSON.stringify(semanticIndexOptions(spec.options));
}

module.exports = {
  indexMatchesContract,
  sameIndexKeys,
  semanticIndexOptions,
};
