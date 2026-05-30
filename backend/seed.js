/**
 * Seed dev users. Requires MONGO_URI in backend/.env
 * Usage: npm run seed
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGO_URI in backend/.env before seeding.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@ezformat.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin123456";

  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    admin = await User.create({
      name: "Admin",
      email: adminEmail,
      password: adminPassword,
      role: "admin",
      plan: "Yearly",
    });
    console.log("Created admin:", adminEmail);
  } else {
    console.log("Admin already exists:", adminEmail);
  }

  await mongoose.disconnect();
  console.log("Seed done.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
