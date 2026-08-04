require("dotenv").config();

const mongoose = require("mongoose");
const WebsiteVisit = require("../models/WebsiteVisit");
const { buildSeedVisits } = require("../services/websiteVisitService");

async function seedWebsiteVisits() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("Set MONGO_URI in backend/.env before seeding website visits.");
  }

  const endDateKey = process.env.WEBSITE_VISIT_SEED_END_DATE || "2026-08-05";
  const rows = buildSeedVisits(endDateKey);

  await mongoose.connect(mongoUri);
  await WebsiteVisit.init();
  const result = await WebsiteVisit.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { dateKey: row.dateKey },
        update: {
          $setOnInsert: { dateKey: row.dateKey },
          $max: { count: row.count },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  console.log(
    `Website visits seeded through ${endDateKey}: ${result.upsertedCount} inserted, ${result.matchedCount} matched or raised.`,
  );
}

seedWebsiteVisits()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
