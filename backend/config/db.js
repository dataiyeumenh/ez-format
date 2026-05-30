const mongoose = require("mongoose");
const dns = require("dns").promises;

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;
  const isProduction = process.env.NODE_ENV === "production";

  if (!mongoUri) {
    if (isProduction) {
      console.error("[DB] MONGO_URI is required in production.");
      process.exit(1);
    }
    console.warn(
      "[DB] MONGO_URI not set — auth/admin disabled. Converter still works via Python.",
    );
    return;
  }

  try {
    const mongoHost = mongoUri.split("@")[1]?.split("/")[0] || "unknown";
    console.log("[DB] Connecting to MongoDB…", mongoHost);

    if (mongoHost !== "unknown") {
      const srvHost = mongoHost
        .replace(/^mongodb\+srv:\/\//, "")
        .replace(/^mongodb:\/\//, "");
      try {
        await dns.resolveSrv(`_mongodb._tcp.${srvHost}`);
      } catch (dnsError) {
        console.warn("[DB] SRV DNS lookup failed:", dnsError.message);
      }
    }

    const conn = await mongoose.connect(mongoUri);
    console.log("[DB] MongoDB connected:", conn.connection.host);
  } catch (error) {
    console.error("[DB] MongoDB connection failed:", error.message);
    if (isProduction) {
      process.exit(1);
    }
    console.warn("[DB] Continuing without database in development mode.");
  }
};

module.exports = connectDB;
