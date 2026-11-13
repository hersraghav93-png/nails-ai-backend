const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const CONFIG = require("../config");
const { scoreSectionRelevance } = require("../utils/helpers");
const { buildKnowledgeDatabase } = require("../builder/knowledgeBuilder");

/**
 * ==========================================================================
 * AI SERVICE MODULE (`src/services/aiService.js`)
 * Manages in-memory knowledge database, hybrid context retrieval, prompt
 * construction, and strictly grounded Gemini API generation.
 * ==========================================================================
 */

let knowledgeCache = null;
let genAI = null;

/**
 * Initializes the Gemini API SDK and loads `knowledge/database.json` into memory.
 * If the database does not exist, triggers an initial build automatically.
 */
function initAiService() {
  if (!CONFIG.geminiApiKey) {
    console.warn("⚠️ [AI Service Warning] GEMINI_API_KEY is missing or empty in .env!");
  } else {
    genAI = new GoogleGenerativeAI(CONFIG.geminiApiKey);
  }

  loadKnowledgeDatabase();
}

/**
 * Loads the structured knowledge database from disk (`knowledge/database.json`).
 * Preserves the previous in-memory cache if parsing or file access fails.
 * @returns {Object} Database object
 */
function loadKnowledgeDatabase() {
  try {
    if (!fs.existsSync(CONFIG.databasePath)) {
      console.log("⚠️ [AI Service] Database not found on disk. Automatically building from frontend workspace...");
      knowledgeCache = buildKnowledgeDatabase();
    } else {
      const raw = fs.readFileSync(CONFIG.databasePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.sections)) {
        throw new Error("Database content is malformed (missing sections array).");
      }
      knowledgeCache = parsed;
      console.log(`✅ [AI Service] Loaded knowledge base v${knowledgeCache.metadata.version} into memory (${knowledgeCache.sections.length} sections).`);
    }
  } catch (err) {
    console.error("❌ [AI Service Error] Failed to load knowledge database:", err.message);
    if (!knowledgeCache || !Array.isArray(knowledgeCache.sections) || knowledgeCache.sections.length === 0) {
      knowledgeCache = { metadata: {}, sections: [] };
    } else {
      console.warn("⚠️ [AI Service Warning] Retained previous in-memory knowledge cache following load failure.");
    }
  }
  return knowledgeCache;
}

/**
 * Reloads the knowledge base from disk (e.g. after dynamic rebuild).
 * Preserves the existing in-memory cache if reading or parsing the file fails.
 */
function reloadKnowledge() {
  try {
    if (!fs.existsSync(CONFIG.databasePath)) {
      throw new Error(`Knowledge database file does not exist on disk at: ${CONFIG.databasePath}`);
    }
    const raw = fs.readFileSync(CONFIG.databasePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      throw new Error("Reload rejected: Database file is empty or malformed.");
    }
    knowledgeCache = parsed;
    console.log(`✅ [AI Service] Successfully reloaded knowledge base v${knowledgeCache.metadata.version} into memory (${knowledgeCache.sections.length} sections).`);
    return knowledgeCache;
  } catch (err) {
    console.error("❌ [AI Service Error] Failed to reload knowledge database:", err.message);
    if (knowledgeCache && Array.isArray(knowledgeCache.sections) && knowledgeCache.sections.length > 0) {
      console.warn("⚠️ [AI Service Warning] Retaining existing in-memory knowledge cache to ensure continuous service.");
    } else {
      knowledgeCache = { metadata: {}, sections: [] };
    }
    return knowledgeCache;
  }
}

/**
 * Retrieves and ranks the most relevant sections from the in-memory knowledge base
 * based on the user's chat message.
 * @param {string} userQuery - Customer chat message
 * @returns {Object} { highlights: Array<Object>, fullKnowledgeXml: string }
 */
function retrieveRelevantContext(userQuery) {
  if (!knowledgeCache || !knowledgeCache.sections) {
    return { highlights: [], selectedKnowledgeXml: "<knowledge_base></knowledge_base>" };
  }

  const sections = knowledgeCache.sections;
  const scored = sections.map((sec) => ({
    section: sec,
    score: scoreSectionRelevance(sec, userQuery)
  }));

  // Sort descending by relevance score
  scored.sort((a, b) => b.score - a.score);

  // Top retrieved highlights with positive score
  const topHighlights = scored
    .filter((item) => item.score > 0)
    .slice(0, CONFIG.maxRetrievedSections)
    .map((item) => item.section);

  // Baseline foundational sections always included for grounding brand identity, services, and festive offers
  const baselineIds = new Set([
    "index.html#home",
    "index.html#about",
    "index.html#services",
    "index.html#contact",
    "index.html#diwali-offers-overview"
  ]);

  // Combine baseline sections with topHighlights (deduplicated by ID)
  const contextSectionsMap = new Map();
  for (const sec of sections) {
    if (baselineIds.has(sec.id)) {
      contextSectionsMap.set(sec.id, sec);
    }
  }
  for (const h of topHighlights) {
    contextSectionsMap.set(h.id, h);
  }

  const contextSections = Array.from(contextSectionsMap.values());

  // Selective structured XML representation (avoids massive token injection of the entire 137-section database)
  let selectedXml = `<knowledge_base brand="Nails by Divya" generatedAt="${knowledgeCache.metadata.generatedAt || ""}">\n`;
  for (const sec of contextSections) {
    const aliasAttr = Array.isArray(sec.aliases) && sec.aliases.length > 0 ? ` aliases="${sec.aliases.slice(0, 10).join(", ")}"` : "";
    selectedXml += `  <section id="${sec.id}" category="${sec.category || "General"}"${sec.productName ? ` productName="${sec.productName}"` : ""}${sec.price ? ` price="${sec.price}"` : ""}${aliasAttr}>\n`;
    selectedXml += `    <title>${sec.title || ""}</title>\n`;
    selectedXml += `    <content>\n${sec.content || ""}\n    </content>\n`;
    selectedXml += `  </section>\n`;
  }
  selectedXml += `</knowledge_base>`;

  return { highlights: topHighlights, selectedKnowledgeXml: selectedXml };
}

/**
 * Generates an AI response for a customer message using strictly grounded knowledge.
 * @param {string} userMessage - Customer message
 * @param {Object} options - Optional context: { productContext?: string, history?: Array<{role: string, content: string}> }
 * @returns {Promise<string>} AI reply
 */
async function generateChatReply(userMessage, options = {}) {
  if (!genAI) {
    throw new Error("Gemini API client is not initialized. Check GEMINI_API_KEY in .env.");
  }

  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    return "Hi! I'm Divv 💅🏻 — Your Nail Stylist. How can I help you discover your perfect press-on set or book an at-home appointment today?";
  }

  const { productContext = null, history = [] } = options;

  // If customer refers to "this", "it", or "this design" while viewing a product, boost retrieval with productContext
  let retrievalQuery = userMessage;
  if (productContext && /\b(this|it|one|design|set|here|colour|color|shape|almond|square|coffin|stiletto|price|cost|how much|order|buy)\b/i.test(userMessage)) {
    retrievalQuery = `${userMessage} ${productContext}`;
  }

  const { highlights, selectedKnowledgeXml } = retrieveRelevantContext(retrievalQuery);

  let highlightsText = "";
  if (highlights.length > 0) {
    highlightsText = "\n<retrieved_highlights>\n" +
      highlights.map((h) => {
        const aliasHeader = Array.isArray(h.aliases) && h.aliases.length > 0 ? ` | Aliases: ${h.aliases.slice(0, 10).join(", ")}` : "";
        return `[Section: ${h.title}${h.productName ? ` | Product Name: ${h.productName}` : ""}${aliasHeader}]\n${h.content}`;
      }).join("\n\n---\n\n") +
      "\n</retrieved_highlights>\n";
  }

  let historyText = "";
  if (Array.isArray(history) && history.length > 0) {
    historyText = "\n--- BROWSING SESSION CONVERSATION HISTORY ---\n" +
      history.slice(-8).map((turn) => {
        const roleLabel = turn.role === "user" ? "Customer" : "Divv 💅🏻";
        return `${roleLabel}: ${turn.content}`;
      }).join("\n\n") +
      "\n--- END SESSION HISTORY ---\n";
  }

  const productContextText = productContext
    ? `\nCURRENT PRODUCT CONTEXT (The customer is currently viewing or has selected this exact product on the website): "${productContext}". If the customer says "this design", "this one", "it", "this set", "can I get this in almond?", or asks about price/options without naming a product, they are asking specifically about "${productContext}".\n`
    : `\nCURRENT PRODUCT CONTEXT: No specific product modal is open.\n`;

  const systemPrompt = `You are Divv 💅🏻, the official AI Nail Stylist for Nails by Divya — a luxury bespoke nail artistry brand by freelance artist Divya based in Delhi NCR, India.

CRITICAL RULES FOR DIVV IDENTITY, ACCURACY, AND CONVERSATION STYLE:
1. IDENTITY & TONE: You are Divv 💅🏻 — Your Nail Stylist. You help customers discover the perfect nail set, recommend products, compare designs, explain services, answer FAQs, explain delivery, explain appointments, and explain customisations. Speak naturally like an experienced, warm, friendly, and elegant luxury nail stylist and beauty consultant. Never robotic. Never sound like AI. You MUST NEVER use phrases like "As an AI...", "Based on the provided information...", "According to the knowledge base...", or "I apologize...". Keep responses concise, warm, and professional (typically 2 to 4 sentences unless recommending designs or answering detailed FAQs).
2. DIVV IS NOT DIVYA (HUMAN HANDOFF): You are Divv 💅🏻, the AI Stylist. You are NOT Divya. Never pretend to be Divya. Whenever you cannot confidently answer from factual website knowledge, OR whenever the customer asks about custom designs, exact availability, order modifications, special requests, personal nail advice, complex situations, or anything not on the website, respond naturally and hand over to Divya. For example: "I'd love to help with that. Since this needs personal guidance, please chat directly with Divya."
3. GROUNDED IN FACTUAL KNOWLEDGE ONLY: You MUST answer customer questions accurately using ONLY the factual information, prices, policies, services, SKUs, and details provided inside the <retrieved_highlights> and <knowledge_base> below. You MUST NOT invent, guess, assume, or hallucinate any products, attributes, prices, or policies.
4. CANONICAL SERVICE CATALOGUE & PRICING:
   Always state accurate canonical catalogue prices for at-home services across Delhi NCR:
   - Bespoke Gel Extensions: Base price ₹1,499 | Active promotional offer: ₹999. Sculpted tips using professional soft gel or polygel tailored to custom length and shape.
   - Natural Nail Overlay & Strengthening: Base price ₹1,299 | Active promotional offer: ₹999. Structured gel layer applied over natural nails to add strength, prevent breaking, and provide a protective canvas.
   - Signature Manicure & Power Polish / Shellac: Base price ₹1,199 | Active promotional offer: ₹999. High-gloss gel manicure on natural nails without extensions.
   - 3D, Chrome & Custom Nail Art: Custom quotation (tailored to your outfit, motifs, and complexity upon personal consultation with Divya).
   - Safe Extension Removal: Price on enquiry (gentle, damage-free professional soak-off).
   - French Nails: Design add-on / styling finish ("French Tip Precision Detailing"), NOT an independent primary service.
5. AUDITED ACTIVE PROMOTIONS VS INACTIVE / UNVERIFIED CLAIMS:
   - Active Verified Studio Promotions:
     1. All 22 catalog press-on nail sets are available at the verified promotional price of ₹599 (regular catalog prices range from ₹699 to ₹1,399 across designs).
     2. At-home nail services across Delhi NCR start from promotional ₹999 (promotional rate for Gel Extensions, Natural Overlay, and Power Polish).
   - Strictly Prohibited & Inactive Claims (NEVER advertise or confirm):
     1. NO Loyalty / Returning Client Discounts: The loyalty program is disabled and pending business approval. You MUST NEVER advertise a "15% OFF for returning clients" or loyalty discount.
     2. NO First-Order Welcome Coupon: There is no automatic welcome discount code (such as 10% off) configured in checkout. Do not promise or mention an automatic 10% first-order discount.
     3. NO Automated Bundles (e.g. Buy 2 Get 1 Free): All individual press-on sets already qualify for the flat ₹599 promotional price; any custom multi-set bundle deals or bridal party sets must be confirmed directly with Divya on WhatsApp.
     4. NO Free Shipping / Free Delivery: Press-on delivery charges are location-based, calculated separately from product price, and confirmed manually by the studio. Never claim or invent free delivery.
     5. NO Fixed Travel Fees: Travel feasibility and any travel charges for at-home appointments in Delhi NCR (Delhi, Gurgaon, Noida, South/Central Delhi, Aerocity) are reviewed and confirmed manually by Divya based on location. Never quote a fixed travel fee or claim travel is free.
6. AT-HOME SALON SERVICE PROTOCOL (DELHI NCR):
   - Personal at-home nail appointments are available across Delhi NCR (Delhi, Gurgaon / Gurugram, Noida, South Delhi, Central Delhi, Aerocity). Operating hours: 12 PM – 6 PM.
   - Divya brings all professional equipment: electric drills, LED lamps, single-use files, sterilized implements, and soft gel collections directly to the client's home.
   - Appointments must be requested on the website or via WhatsApp and are confirmed personally by Divya. Divv cannot directly confirm bookings or schedule appointments.
7. PRESS-ON NAIL SIZING & CUSTOMIZATION:
   - Sets are available in 4 standard sizes: XS (14, 11, 12, 10, 8 mm), S (15, 12, 13, 11, 8 mm), M (16, 12, 13, 11, 9 mm), and L (18, 13, 14, 12, 10 mm) measured thumb-to-pinky.
   - Custom sizing is complimentary: Clients can select "Custom" and measure the widest part of their natural nail beds using tape and a millimeter ruler, or message Divya with their measurements.
   - Available shapes include Almond, Coffin, Square, Oval, and Stiletto.
8. PAN-INDIA DELIVERY & DISPATCH:
   - Press-on nails are handcrafted in Delhi NCR and shipped nationwide across India.
   - Same-day delivery in Delhi NCR is subject to artist schedule and confirmation via WhatsApp.
   - Delivery charges are location-based and confirmed separately from product prices.
9. ORDER & PAYMENT INTEGRITY:
   - Divv is an AI Stylist and cannot verify payment status or mark orders as paid. Orders and payments are handled securely through verified studio checkout boundaries.
10. PORTFOLIO & DESIGNS:
   - 60 bespoke portfolio designs in the lookbook across chrome, nude, bridal, and custom nail art. Any design can be ordered as handmade press-ons delivered across India or chosen as reference inspiration for an at-home appointment.
11. PRODUCT NAMES FIRST (NEVER EXPOSE SKUS OR ALIAS LISTS):
   - Always use public Product Names (e.g., "Molten Chrome Ripple", "Maharaja Velvet"). Never mention internal SKU codes (CAS-004, WED-005) unless the customer explicitly typed that SKU first.
12. RECOMMENDATIONS & STYLING GUIDANCE:
   - Recommend 2 to 4 designs that match customer preferences and explain why each fits their style.
   - Use CURRENT PRODUCT CONTEXT when the customer refers to "this", "this design", or "this one".
13. CLEAN FORMATTING:
   - Use clean Markdown with bold prices and names (e.g., **₹1,499** base / **₹999** promotional) for clarity. Never output raw HTML tags.
${productContextText}${historyText}
--- KNOWLEDGE DATABASE ---
${highlightsText}
${selectedKnowledgeXml}
--- END KNOWLEDGE DATABASE ---`;

  console.log("🔍 [Runtime Debug] CONFIG.geminiModel:", CONFIG.geminiModel);
  console.log("🔍 [Runtime Debug] process.env.GEMINI_MODEL:", process.env.GEMINI_MODEL);
  console.log(`🤖 [Runtime Debug] Initializing generative model with name: "${CONFIG.geminiModel}"`);

  const model = genAI.getGenerativeModel({
    model: CONFIG.geminiModel,
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.25, // Sleek balance of factual precision and warm luxury consultant tone
      topP: 0.85,
      maxOutputTokens: 1024,
    }
  });

  try {
    const result = await model.generateContent(userMessage);
    const reply = result.response.text();
    return reply || "I couldn't find that information on our website. I'd love to help with that—since this needs personal guidance, please chat directly with Divya.";
  } catch (error) {
    console.error("❌ [AI Service Generation Error]:", error);
    throw error;
  }
}

/**
 * Returns read-only operational telemetry for health check diagnostics.
 */
function getKnowledgeStatus() {
  return {
    isLoaded: Boolean(knowledgeCache),
    version: knowledgeCache && knowledgeCache.metadata ? knowledgeCache.metadata.version : null,
    sectionsCount: knowledgeCache && knowledgeCache.sections ? knowledgeCache.sections.length : 0,
    generatedAt: knowledgeCache && knowledgeCache.metadata ? knowledgeCache.metadata.generatedAt : null,
    hasGeminiKey: Boolean(CONFIG.geminiApiKey),
    model: CONFIG.geminiModel,
  };
}

module.exports = {
  initAiService,
  loadKnowledgeDatabase,
  reloadKnowledge,
  retrieveRelevantContext,
  generateChatReply,
  getKnowledgeStatus,
};
