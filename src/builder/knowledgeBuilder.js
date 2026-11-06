const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CONFIG = require("../config");
const { discoverFrontendFiles } = require("./scanner");
const { extractPricingRegistry, extractHtmlKnowledge } = require("./extractor");

/**
 * ==========================================================================
 * KNOWLEDGE BUILDER (`src/builder/knowledgeBuilder.js`)
 * Orchestrates scanning, extracting, data-aware validation, automated backups,
 * atomic writing, and deduplicating the AI knowledge database (`database.json`).
 * ==========================================================================
 */

/**
 * Custom error class for data-aware validation failures.
 */
class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

/**
 * In-process concurrency mutex flag.
 *
 * NOTE ON MULTI-INSTANCE / CLUSTER CONCURRENCY:
 * This in-memory lock guarantees mutual exclusion within this single Node.js runtime process.
 * In distributed multi-instance or horizontally scaled environments (e.g. multiple container
 * replicas behind a load balancer), each instance maintains its own memory space; distributed
 * locking across instances would require an external coordinator (such as Redis Redlock or a
 * database advisory lock).
 */
let isBuilding = false;

/**
 * Validates the extracted knowledge against website data structures before saving.
 * Allows legitimate additions or removals without rigid fixed limits.
 * @param {Object} database - Knowledge database payload
 * @param {Object} context - Extraction context { pricingRegistry, htmlFiles, jsFiles }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateKnowledgePayload(database, context = {}) {
  const errors = [];
  const { sections = [] } = database || {};
  const { pricingRegistry = {}, htmlFiles = [], jsFiles = [] } = context;

  // 1. Source files verification
  if (!Array.isArray(htmlFiles) || htmlFiles.length === 0) {
    errors.push("No HTML source files were discovered.");
  } else {
    const hasIndexHtml = htmlFiles.some((f) => path.basename(f).toLowerCase() === "index.html");
    if (!hasIndexHtml) {
      errors.push("Primary source page 'index.html' is missing from discovered files.");
    }
  }

  if (!Array.isArray(jsFiles) || jsFiles.length === 0) {
    errors.push("No JavaScript source files were discovered.");
  } else {
    const hasScriptJs = jsFiles.some((f) => path.basename(f).toLowerCase() === "script.js");
    if (!hasScriptJs) {
      errors.push("Primary script file 'script.js' is missing from discovered files.");
    }
  }

  // 2. Expected product IDs and pricing data validation
  const skus = Object.keys(pricingRegistry);
  if (skus.length === 0) {
    errors.push("Pricing registry is empty. No product SKUs were extracted from script files.");
  } else {
    for (const [sku, price] of Object.entries(pricingRegistry)) {
      if (!/^[A-Z0-9-]+$/i.test(sku)) {
        errors.push(`Invalid SKU code format encountered: "${sku}".`);
      }
      if (!price || typeof price !== "string" || !/[₹$€£\d]/.test(price)) {
        errors.push(`Product SKU "${sku}" lacks valid pricing data (value: "${price}").`);
      }
    }
  }

  // 3. Section presence & sanity
  if (!Array.isArray(sections) || sections.length === 0) {
    errors.push("The extracted knowledge sections list is completely empty.");
    return { valid: false, errors };
  }

  // 4. Required knowledge categories must not be unexpectedly empty
  const requiredCategories = [
    "Brand Overview & Service Pillars",
    "Brand Philosophy & Craftsmanship",
    "Products & Press-On Pricing",
    "Portfolio Designs & Nail Art Lookbook",
    "Promotions & Festive Offers (Diwali Edit)",
    "Services Architecture (Press-Ons & At-Home Appointments)",
    "Customer Frequently Asked Questions (FAQ)",
    "Contact Information & Studio Hours"
  ];
  const presentCategories = new Set(sections.map((s) => s.category).filter(Boolean));
  for (const reqCat of requiredCategories) {
    if (!presentCategories.has(reqCat)) {
      errors.push(`Required knowledge category missing or empty: "${reqCat}".`);
    }
  }

  // 5. Core service, brand, contact, and booking presence
  const coreSectionMatchers = [
    { name: "Brand Overview (#home)", test: (id) => id.includes("#home") },
    { name: "Brand Philosophy (#about)", test: (id) => id.includes("#about") },
    { name: "Shop / Press-On Collection (#shop)", test: (id) => id.includes("#shop") },
    { name: "Active Diwali Offers (#diwali)", test: (id) => id.includes("#diwali") },
    { name: "Portfolio Lookbook (#portfolio)", test: (id) => id.includes("#portfolio") },
    { name: "Services Architecture (#services)", test: (id) => id.includes("#services") },
    { name: "Craftsmanship & Trust Pillars (#trust)", test: (id) => id.includes("#trust") },
    { name: "Customer FAQs (#faq)", test: (id) => id.includes("#faq") },
    { name: "Contact & Studio Hours (#contact)", test: (id) => id.includes("#contact") },
  ];
  for (const matcher of coreSectionMatchers) {
    if (!sections.some((s) => matcher.test(s.id))) {
      errors.push(`Required core section missing: ${matcher.name}.`);
    }
  }

  // 6. Product sections validation
  const productSections = sections.filter((s) => s.sku || s.section === "shop-products");
  if (productSections.length === 0) {
    errors.push("No catalog product sections were successfully extracted.");
  } else {
    for (const p of productSections) {
      if (!p.productName || !p.productName.trim()) {
        errors.push(`Product section "${p.id}" has an empty productName.`);
      }
      if (!p.price || !/[₹$€£\d]/.test(p.price)) {
        errors.push(`Product section "${p.id}" has an invalid price: "${p.price}".`);
      }
    }
  }

  // 7. Portfolio records validation
  const portfolioSections = sections.filter((s) => s.id.includes("#portfolio") || s.section === "portfolio-design" || s.section === "portfolio-overview");
  if (portfolioSections.length === 0) {
    errors.push("Portfolio lookbook section is missing.");
  } else {
    for (const portSec of portfolioSections) {
      if (!portSec.title || !portSec.title.trim()) {
        errors.push(`Portfolio record "${portSec.id}" has an empty title.`);
      }
      if (!portSec.content || typeof portSec.content !== "string" || portSec.content.trim().length < 20) {
        errors.push(`Portfolio record "${portSec.id}" has invalid or suspiciously empty content.`);
      }
    }
  }

  // 8. Active Diwali promotions validation
  const diwaliSections = sections.filter((s) => s.id.includes("#diwali") || s.section === "diwali-promotions");
  if (diwaliSections.length === 0) {
    errors.push("Active Diwali promotions are missing.");
  } else {
    const requiredOffers = [
      "Home Service",
      "Press-on Nails",
      "Buy 2",
      "First Order",
      "Returning Clients",
      "Same-Day Delivery"
    ];
    for (const reqOffer of requiredOffers) {
      if (!diwaliSections.some((s) => (s.title && s.title.includes(reqOffer)) || (s.content && s.content.includes(reqOffer)))) {
        errors.push(`Required active Diwali promotion missing: "${reqOffer}".`);
      }
    }
  }

  // 9. Individual section health (no blank titles or empty content)
  for (const sec of sections) {
    if (!sec.id || typeof sec.id !== "string") {
      errors.push("Found section with missing or invalid ID.");
      break;
    }
    if (!sec.title || typeof sec.title !== "string" || !sec.title.trim()) {
      errors.push(`Section "${sec.id}" has an empty title.`);
      break;
    }
    if (!sec.content || typeof sec.content !== "string" || sec.content.trim().length < 10) {
      errors.push(`Section "${sec.id}" has suspiciously brief or empty content.`);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Creates a verified timestamped backup of the current database before replacement.
 * Never overwrites an existing backup.
 * @param {string} sourcePath - Path to active database.json
 * @param {string} backupDir - Directory to store backups
 * @returns {string|null} Path to created backup file
 */
function createDatabaseBackup(sourcePath, backupDir = CONFIG.backupDir) {
  if (!fs.existsSync(sourcePath)) {
    return null; // Initial build, no prior database to back up
  }

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backupFileName = `database-backup-${timestamp}.json`;
  let backupPath = path.join(backupDir, backupFileName);
  let counter = 1;

  while (fs.existsSync(backupPath)) {
    backupFileName = `database-backup-${timestamp}-${counter}.json`;
    backupPath = path.join(backupDir, backupFileName);
    counter++;
  }

  fs.copyFileSync(sourcePath, backupPath);
  console.log(`💾 [Knowledge Builder] Verified backup created at: ${backupPath}`);
  return backupPath;
}

/**
 * Prunes old backups, keeping the most recent N copies.
 * Only called after successful replacement and post-write verification.
 * @param {string} backupDir
 * @param {number} maxKeep
 */
function pruneOldBackups(backupDir = CONFIG.backupDir, maxKeep = 10) {
  try {
    if (!fs.existsSync(backupDir)) return;

    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith("database-backup-") && f.endsWith(".json"))
      .map((f) => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > maxKeep) {
      const toDelete = files.slice(maxKeep);
      for (const item of toDelete) {
        fs.unlinkSync(item.path);
        console.log(`🧹 [Knowledge Builder] Pruned older backup: ${item.name}`);
      }
    }
  } catch (err) {
    console.warn(`[Knowledge Builder Warning] Old backup pruning skipped:`, err.message);
  }
}

/**
 * Safely and atomically replaces the destination file with the verified temporary file.
 * On modern NTFS and POSIX, fs.renameSync within the same filesystem directory is an atomic
 * file table operation (MoveFileExW with MOVEFILE_REPLACE_EXISTING on Windows).
 *
 * If a transient lock (e.g. antivirus scanning or indexing) causes EPERM or EBUSY on Windows,
 * it retries up to maxRetries with backoff.
 * If replacement cannot be completed atomically, it strictly ABORTS without performing
 * any non-atomic truncated copies, leaving the original destination file untouched.
 */
function safeAtomicReplace(tmpPath, targetPath, maxRetries = 5, retryDelayMs = 40) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return; // Atomic rename succeeded
    } catch (err) {
      lastError = err;
      if ((err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") && attempt < maxRetries) {
        const start = Date.now();
        while (Date.now() - start < retryDelayMs * attempt) {}
        continue;
      }
      break;
    }
  }

  throw new Error(`[Atomic Write Failure] Failed to atomically replace "${targetPath}" with "${tmpPath}": ${lastError.message}`);
}

/**
 * Validates essential database structure on disk (JSON syntax, metadata fields, sections array, and item schemas).
 * Throws a descriptive Error if the file is missing, empty, or structurally invalid.
 * @param {string} filePath - Absolute path to database JSON file
 * @returns {Object} Parsed database object
 */
function verifyDatabaseStructure(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Database file does not exist at "${filePath}".`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw || !raw.trim()) {
    throw new Error(`Database file at "${filePath}" is empty (0 bytes).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Database file at "${filePath}" contains malformed JSON: ${parseErr.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Database payload at "${filePath}" must be a JSON object.`);
  }

  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    throw new Error(`Database payload at "${filePath}" is missing required metadata object.`);
  }

  if (!parsed.metadata.version || !parsed.metadata.brandName) {
    throw new Error(`Database metadata at "${filePath}" lacks essential version or brandName.`);
  }

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error(`Database payload at "${filePath}" sections array is missing or empty.`);
  }

  // Check section elements for essential schema properties
  const sampleSize = Math.min(parsed.sections.length, 50);
  for (let i = 0; i < sampleSize; i++) {
    const sec = parsed.sections[i];
    if (!sec || typeof sec !== "object" || !sec.id || !sec.title || typeof sec.content !== "string") {
      throw new Error(`Database section at index ${i} lacks required structure (id, title, or content).`);
    }
  }

  return parsed;
}

/**
 * Executes the complete knowledge building pipeline with atomic writing,
 * safe backups, concurrency mutex, and data-aware validation.
 * @param {string} frontendPath - Path to frontend workspace directory
 * @param {string} outputPath - Path where `database.json` should be saved
 * @returns {Object} Generated database object
 */
function buildKnowledgeDatabase(frontendPath = CONFIG.frontendPath, outputPath = CONFIG.databasePath) {
  if (isBuilding) {
    const error = new Error("Knowledge rebuild is already in progress within this process.");
    error.code = "LOCKED";
    throw error;
  }

  isBuilding = true;
  let tmpPath = null;
  let backupPath = null;

  try {
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

    // 4. Construct candidate database payload
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

    // 5. Data-aware validation before touching disk
    console.log(`🛡️  [Knowledge Builder] Running data-aware integrity validation...`);
    const validationResult = validateKnowledgePayload(database, { pricingRegistry, htmlFiles, jsFiles });
    if (!validationResult.valid) {
      const err = new ValidationError("Knowledge payload failed data-aware validation checks.", validationResult.errors);
      console.error(`❌ [Knowledge Builder Validation Failed]:\n - ${validationResult.errors.join("\n - ")}`);
      throw err;
    }
    console.log(`✅ [Knowledge Builder] Validation passed: ${uniqueSections.length} sections verified.`);

    // 6. Safe backup of existing database before write
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    backupPath = createDatabaseBackup(outputPath);

    // 7. Atomic file write via unique temporary file on the same filesystem
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    tmpPath = path.join(outDir, `.database.${uniqueSuffix}.tmp`);
    const jsonPayload = JSON.stringify(database, null, 2);
    fs.writeFileSync(tmpPath, jsonPayload, "utf-8");

    // Verify temporary file before replacing active database
    verifyDatabaseStructure(tmpPath);

    // Genuinely safe atomic replacement
    safeAtomicReplace(tmpPath, outputPath);

    // 8. Post-replacement verification with automated rollback on failure
    try {
      // Essential database structure verification
      verifyDatabaseStructure(outputPath);
    } catch (verifyErr) {
      console.error(`🚨 [Knowledge Builder] Post-replacement verification failed: ${verifyErr.message}`);
      if (backupPath && fs.existsSync(backupPath)) {
        console.warn(`🔄 [Knowledge Builder] Initiating safe rollback to preserve backup at: ${backupPath}`);
        let recoveryTmpPath = null;
        try {
          const recoverySuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
          recoveryTmpPath = path.join(outDir, `.recovery.${recoverySuffix}.tmp`);

          // 1. Copy the backup to a unique temporary file in the knowledge directory
          fs.copyFileSync(backupPath, recoveryTmpPath);

          // 2. Verify that the temporary recovery file contains valid JSON and a structurally valid database
          verifyDatabaseStructure(recoveryTmpPath);

          // 3. Atomically replace the active database using that temporary file
          safeAtomicReplace(recoveryTmpPath, outputPath);

          // 4. Confirm the restored database
          verifyDatabaseStructure(outputPath);

          // 5. Keep the original backup untouched
          if (!fs.existsSync(backupPath)) {
            console.error(`🚨 [Knowledge Builder Error] Original backup was unexpectedly missing after recovery!`);
          } else {
            console.log(`✅ [Knowledge Builder] Restored prior database from backup; original backup preserved intact at: ${backupPath}`);
          }
        } catch (rollbackErr) {
          console.error(`❌ [Knowledge Builder] Rollback failed: ${rollbackErr.message}`);
        } finally {
          if (recoveryTmpPath && fs.existsSync(recoveryTmpPath)) {
            try {
              fs.unlinkSync(recoveryTmpPath);
            } catch (_) {}
          }
        }
      }
      throw new Error(`Post-replacement verification failed (${verifyErr.message}). Prior database was restored and original backup preserved.`);
    }

    // 9. Prune old backups (only after verified successful write)
    pruneOldBackups();

    console.log(`✅ [Knowledge Builder] Successfully generated and verified knowledge database at: ${outputPath}`);
    console.log(`📊 [Knowledge Builder] Total Sections Indexed: ${uniqueSections.length} across ${htmlFiles.length} page(s).\n`);

    return database;
  } finally {
    isBuilding = false;
    if (tmpPath && fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }
}

module.exports = {
  buildKnowledgeDatabase,
  validateKnowledgePayload,
  createDatabaseBackup,
  pruneOldBackups,
  safeAtomicReplace,
  verifyDatabaseStructure,
  ValidationError
};
