const mongoose = require("mongoose");
const dns = require("dns").promises;
const CouponUsage = require("../models/CouponUsage");

const PAYMENT_SETTLEMENT_NOT_READY = "PAYMENT_SETTLEMENT_NOT_READY";
const MONGO_TRANSACTIONS_NOT_READY = "MONGO_TRANSACTIONS_NOT_READY";
const COUPON_USAGE_PAYMENT_UNIQUE_INDEX = Object.freeze({
  keys: Object.freeze({ payment: 1 }),
  options: Object.freeze({
    unique: true,
    partialFilterExpression: Object.freeze({ payment: Object.freeze({ $type: "objectId" }) }),
  }),
});
const UNVERIFIED_READINESS = Object.freeze({
  ready: false,
  deployment: "unverified",
  reason: "MongoDB transaction capability has not been verified.",
});

let paymentSettlementReadiness = { ...UNVERIFIED_READINESS };

function assessMongoTransactionReadiness({ topologyType, hello } = {}) {
  if (hello?.logicalSessionTimeoutMinutes == null) {
    return {
      ready: false,
      deployment: "unverified",
      reason: "MongoDB logical sessions are required for payment settlement transactions.",
    };
  }

  if (hello?.msg === "isdbgrid" || topologyType === "Sharded") {
    return { ready: true, deployment: "sharded", reason: null };
  }

  if (hello?.setName || topologyType === "ReplicaSetWithPrimary") {
    return { ready: true, deployment: "replica-set", reason: null };
  }

  return {
    ready: false,
    deployment: "standalone",
    reason:
      "PayOS settlement requires a MongoDB replica set or sharded cluster with transactions enabled.",
  };
}

async function inspectConnectedMongoTransactionReadiness(connection) {
  const mongoConnection = connection?.connection || connection;
  const client = mongoConnection?.getClient?.() || mongoConnection?.client;
  const topologyType = client?.topology?.description?.type;

  try {
    const hello = await mongoConnection?.db?.admin().command({ hello: 1 });
    return assessMongoTransactionReadiness({ topologyType, hello });
  } catch (error) {
    return {
      ready: false,
      deployment: "unverified",
      reason: `Could not verify MongoDB transaction capability: ${error.message}`,
    };
  }
}

function getPaymentSettlementReadiness() {
  return { ...paymentSettlementReadiness };
}

function setPaymentSettlementReadiness(readiness) {
  paymentSettlementReadiness = { ...readiness };
  return getPaymentSettlementReadiness();
}

function assertPaymentSettlementReady() {
  if (paymentSettlementReadiness.ready) return;
  const error = new Error(paymentSettlementReadiness.reason);
  error.code = PAYMENT_SETTLEMENT_NOT_READY;
  throw error;
}

function assertMongoTransactionReady(featureName = "This operation") {
  if (paymentSettlementReadiness.ready) return;
  const error = new Error(
    `${featureName} requires MongoDB transactions. ${paymentSettlementReadiness.reason}`,
  );
  error.code = MONGO_TRANSACTIONS_NOT_READY;
  error.statusCode = 503;
  throw error;
}

function isPayOSSettlementConfigured(env = process.env) {
  return ["PAYOS_CLIENT_ID", "PAYOS_API_KEY", "PAYOS_CHECKSUM_KEY"].every(
    (name) => Boolean(String(env[name] || "").trim()),
  );
}

async function ensureCouponUsagePaymentUniqueIndex(CouponUsageModel = CouponUsage) {
  const { keys, options } = COUPON_USAGE_PAYMENT_UNIQUE_INDEX;
  return CouponUsageModel.collection.createIndex(keys, options);
}

function createConnectDB({
  mongooseInstance = mongoose,
  dnsResolver = dns,
  env = process.env,
  logger = console,
  ensureCouponUsagePaymentUniqueIndex: ensureCouponUsageIndex =
    ensureCouponUsagePaymentUniqueIndex,
} = {}) {
  return async function connectDB() {
    const mongoUri = env.MONGO_URI;
    const isProduction = env.NODE_ENV === "production";
    if (!mongoUri) {
      setPaymentSettlementReadiness({
        ready: false,
        deployment: "unconfigured",
        reason: "MONGO_URI is required for MongoDB transactions.",
      });
      if (isProduction || isPayOSSettlementConfigured(env)) {
        throw new Error(
          "[DB] MONGO_URI is required for production or PayOS settlement.",
        );
      }
      logger.warn(
        "[DB] MONGO_URI not set — auth/admin disabled. Converter still works via Python.",
      );
      return null;
    }

    try {
      const mongoHost = mongoUri.split("@")[1]?.split("/")[0] || "unknown";
      logger.log("[DB] Connecting to MongoDB…", mongoHost);

      if (mongoHost !== "unknown") {
        const srvHost = mongoHost
          .replace(/^mongodb\+srv:\/\//, "")
          .replace(/^mongodb:\/\//, "");
        try {
          await dnsResolver.resolveSrv(`_mongodb._tcp.${srvHost}`);
        } catch (dnsError) {
          logger.warn("[DB] SRV DNS lookup failed:", dnsError.message);
        }
      }

      const conn = await mongooseInstance.connect(mongoUri);
      logger.log("[DB] MongoDB connected:", conn.connection.host);
      let readiness = await inspectConnectedMongoTransactionReadiness(conn);
      if (readiness.ready) {
        try {
          await ensureCouponUsageIndex();
        } catch (error) {
          readiness = {
            ready: false,
            deployment: readiness.deployment,
            reason: `CouponUsage payment uniqueness migration failed: ${error.message}`,
          };
        }
      }
      setPaymentSettlementReadiness(readiness);
      logger.log(
        `[DB] PayOS settlement transactions: ${readiness.ready ? "ready" : "not ready"} (${readiness.deployment})`,
      );

      if (isPayOSSettlementConfigured(env) && !readiness.ready) {
        throw new Error(readiness.reason);
      }
      return conn;
    } catch (error) {
      setPaymentSettlementReadiness({
        ready: false,
        deployment: "unverified",
        reason: error.message,
      });
      logger.error("[DB] MongoDB connection failed:", error.message);
      if (isProduction || isPayOSSettlementConfigured(env)) throw error;
      logger.warn("[DB] Continuing without database in development mode.");
      return null;
    }
  };
}

const connectDB = createConnectDB();

module.exports = connectDB;
module.exports.PAYMENT_SETTLEMENT_NOT_READY = PAYMENT_SETTLEMENT_NOT_READY;
module.exports.MONGO_TRANSACTIONS_NOT_READY = MONGO_TRANSACTIONS_NOT_READY;
module.exports.assessMongoTransactionReadiness = assessMongoTransactionReadiness;
module.exports.assertMongoTransactionReady = assertMongoTransactionReady;
module.exports.assertPaymentSettlementReady = assertPaymentSettlementReady;
module.exports.createConnectDB = createConnectDB;
module.exports.getPaymentSettlementReadiness = getPaymentSettlementReadiness;
module.exports.inspectConnectedMongoTransactionReadiness =
  inspectConnectedMongoTransactionReadiness;
module.exports.isPayOSSettlementConfigured = isPayOSSettlementConfigured;
module.exports.ensureCouponUsagePaymentUniqueIndex = ensureCouponUsagePaymentUniqueIndex;
