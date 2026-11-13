"use strict";

const fs = require("fs");
const path = require("path");
const { getPool, query } = require("../src/db/pool");

async function applySeeds() {
  const seedsDir = path.resolve(__dirname, "../database/seeds");
  const seedFiles = [
    "001_roles_and_categories.sql",
    "002_catalog_products.sql",
    "003_portfolio_lookbook.sql",
    "004_faqs.sql",
    "005_business_settings.sql",
  ];

  console.log("🌱 Applying Foundation Seeds to Database...");

  for (const file of seedFiles) {
    const filePath = path.join(seedsDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Seed file not found: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(filePath, "utf8");
    console.log(`⚡ Executing ${file}...`);
    await query(sql);
    console.log(`✅ ${file} applied successfully.`);
  }

  console.log("🎉 All foundation seeds applied successfully!\n");
  process.exit(0);
}

applySeeds().catch((err) => {
  console.error("❌ Failed to apply seeds:", err);
  process.exit(1);
});
