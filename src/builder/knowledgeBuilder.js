const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");
const { discoverFrontendFiles } = require("./scanner");
const { extractPricingRegistry, extractHtmlKnowledge } = require("./extractor");

/**
 * ==========================================================================
 * KNOWLEDGE BUILDER (`src/builder/knowledgeBuilder.js`)
 * Orchestrates scanning, extracting, cleaning, deduplicating, and saving
 * the structured AI knowledge database (`knowledge/database.json`).
 * ==========================================================================
 */

/**
 * Executes the complete knowledge building pipeline.
 * @param {string} frontendPath - Path to frontend workspace directory
 * @param {string} outputPath - Path where `database.json` should be saved
 * @returns {Object} Generated database object
 */
function buildKnowledgeDatabase(frontendPath = CONFIG.frontendPath, outputPath = CONFIG.databasePath) {
  console.log(`\n🔍 [Knowledge Builder] Scanning frontend directory: ${frontendPath}`);
  
  const { htmlFiles, jsFiles } = discoverFrontendFiles(frontendPath);
  console.log(`📄 [Knowledge Builder] Discovered ${htmlFiles.length} HTML file(s) and ${jsFiles.length} JS file(s).`);

  // 1. Extract pricing and SKU mappings from JS files
  const pricingRegistry = extractPricingRegistry(jsFiles);
  const skuCount = Object.keys(pricingRegistry).length;
  if (skuCount > 0) {
    console.log(`💰 [Knowledge Builder] Extracted exact pricing for ${skuCount} product SKUs from script files.`);
  }

  // 2. Extract structured sections from all discovered HTML files
  let allSections = [];
  for (const htmlPath of htmlFiles) {
    console.log(`⚙️  [Knowledge Builder] Extracting semantic sections from ${path.basename(htmlPath)}...`);
    const fileSections = extractHtmlKnowledge(htmlPath, pricingRegistry);
    allSections = allSections.concat(fileSections);
  }

  // 3. Deduplicate sections based on title + normalized content fingerprint
  const seenFingerprints = new Set();
  const uniqueSections = [];

  for (const sec of allSections) {
    const fingerprint = `${(sec.title || "").toLowerCase().trim()}|${(sec.content || "").toLowerCase().slice(0, 100).trim()}`;
    if (!seenFingerprints.has(fingerprint)) {
      seenFingerprints.add(fingerprint);
      uniqueSections.push(sec);
    } else {
      console.log(`🧹 [Knowledge Builder] Removed duplicate section: "${sec.title}"`);
    }
  }

  // 4. Construct final structured database payload
  const database = {
    metadata: {
      version: "2.0.0",
      generatedAt: new Date().toISOString(),
      brandName: "Nails by Divya",
      frontendPath,
      totalPages: htmlFiles.length,
      totalSections: uniqueSections.length,
      skuCount
    },
    sections: uniqueSections
  };

  // 5. Ensure output directory exists and write `database.json`
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(database, null, 2), "utf-8");
  console.log(`✅ [Knowledge Builder] Successfully generated knowledge database at: ${outputPath}`);
  console.log(`📊 [Knowledge Builder] Total Sections Indexed: ${uniqueSections.length} across ${htmlFiles.length} page(s).\n`);

  return database;
}

module.exports = {
  buildKnowledgeDatabase
};
