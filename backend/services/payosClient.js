const { PayOS } = require("@payos/node");

let payOSClient;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getPayOSClient() {
  if (!payOSClient) {
    payOSClient = new PayOS({
      clientId: getRequiredEnv("PAYOS_CLIENT_ID"),
      apiKey: getRequiredEnv("PAYOS_API_KEY"),
      checksumKey: getRequiredEnv("PAYOS_CHECKSUM_KEY"),
    });
  }
  return payOSClient;
}

function resetPayOSClientForTests() {
  payOSClient = undefined;
}

module.exports = { getPayOSClient, resetPayOSClientForTests };
