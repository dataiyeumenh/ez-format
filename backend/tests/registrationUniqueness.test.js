const assert = require("node:assert/strict");
const { readdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const backendRoot = path.resolve(__dirname, "..");

function registrations(source, pattern, keyForMatch) {
  return [...source.matchAll(pattern)].map(keyForMatch);
}

function assertUnique(values, label) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], `Duplicate ${label}: ${JSON.stringify(duplicates)}`);
  return counts;
}

test("Express mounts and route registrations are unique", async () => {
  const server = await readFile(path.join(backendRoot, "server.js"), "utf8");
  const gateway = await readFile(
    path.join(backendRoot, "routes", "converterGateway.js"),
    "utf8",
  );

  const mounts = registrations(
    server,
    /app\.use\(\s*["']([^"']+)["']/g,
    (match) => match[1],
  );
  const mountCounts = assertUnique(mounts, "Express mount");
  for (const required of [
    "/api/auth",
    "/api/plans",
    "/api/admin",
    "/api/convert",
    "/api/conversion-runs",
    "/api/payments",
    "/api/converter",
    "/api/converter/context",
    "/api/internal/converter-sessions",
    "/api/reconstructions",
    "/api/student",
  ]) {
    assert.equal(mountCounts.get(required), 1, `${required} must mount exactly once`);
  }

  const gatewayRoutes = registrations(
    gateway,
    /router\.(get|post|put|patch|delete|all)\(\s*["']([^"']+)["']/g,
    (match) => `${match[1].toUpperCase()} ${match[2]}`,
  );
  const gatewayCounts = assertUnique(gatewayRoutes, "converter gateway route");
  for (const required of [
    "GET /capabilities",
    "POST /import-repairs",
    "POST /import-repairs/:repairId/schema",
    "GET /import-repairs/:repairId",
    "POST /import-repairs/:repairId/retry-batches",
    "GET /import-repairs/:repairId/retry-batches/:batchId/download",
  ]) {
    assert.equal(gatewayCounts.get(required), 1, `${required} must register exactly once`);
  }
});

test("converter capabilities has one runtime registration per gateway state", () => {
  const serverPath = require.resolve("../server");
  const previous = {
    CONVERTER_PUBLIC_PROXY_ENABLED: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    CONVERTER_GATEWAY_USAGE_READY: process.env.CONVERTER_GATEWAY_USAGE_READY,
  };

  function registrationsFor(gatewayEnabled) {
    process.env.CONVERTER_PUBLIC_PROXY_ENABLED = gatewayEnabled ? "true" : "false";
    process.env.CONVERTER_GATEWAY_USAGE_READY = gatewayEnabled ? "true" : "false";
    delete require.cache[serverPath];
    const { app } = require("../server");
    const direct = app._router.stack.filter(
      (layer) => layer.route?.path === "/api/converter/capabilities",
    ).length;
    const mountedGateway = app._router.stack
      .filter((layer) => layer.name === "router" && layer.handle?.stack)
      .flatMap((layer) => layer.handle.stack)
      .filter((layer) => layer.route?.path === "/capabilities").length;
    return { direct, mountedGateway };
  }

  try {
    assert.deepEqual(registrationsFor(false), { direct: 1, mountedGateway: 0 });
    assert.deepEqual(registrationsFor(true), { direct: 0, mountedGateway: 1 });
  } finally {
    if (previous.CONVERTER_PUBLIC_PROXY_ENABLED === undefined) {
      delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    } else {
      process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previous.CONVERTER_PUBLIC_PROXY_ENABLED;
    }
    if (previous.CONVERTER_GATEWAY_USAGE_READY === undefined) {
      delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    } else {
      process.env.CONVERTER_GATEWAY_USAGE_READY = previous.CONVERTER_GATEWAY_USAGE_READY;
    }
    delete require.cache[serverPath];
  }
});

test("Mongoose model names are registered exactly once", async () => {
  const modelsRoot = path.join(backendRoot, "models");
  const modelFiles = (await readdir(modelsRoot)).filter((name) => name.endsWith(".js"));
  const registrationsByName = [];
  for (const file of modelFiles) {
    const source = await readFile(path.join(modelsRoot, file), "utf8");
    for (const match of source.matchAll(/mongoose\.model\(\s*["']([^"']+)["']/g)) {
      registrationsByName.push(match[1]);
    }
  }

  const modelCounts = assertUnique(registrationsByName, "Mongoose model registration");
  for (const required of [
    "Coupon",
    "User",
    "VoucherReconstructionRun",
    "StudentFileSession",
    "MisaImportRepairSession",
  ]) {
    assert.equal(modelCounts.get(required), 1, `${required} must register exactly once`);
  }
});
