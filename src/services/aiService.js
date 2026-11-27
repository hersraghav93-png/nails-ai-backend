const fs = require("fs");
const { setTimeout: delay } = require("node:timers/promises");
const { GoogleGenerativeAI, GoogleGenerativeAIAbortError } = require("@google/generative-ai");
const CONFIG = require("../config");
const { scoreSectionRelevance } = require("../utils/helpers");
const { buildKnowledgeDatabase } = require("../builder/knowledgeBuilder");
const { query } = require("../db/pool");
const { calculateItemPricing } = require("./pricingEngine");
const { listAvailableServices } = require("./bookingService");
const { getBookingSchedule } = require("./bookingSchedule");
const { getApprovedDesign } = require("./catalogueDesigns");

class DivvUnavailableError extends Error {
  constructor() {
    super("Divv is temporarily unavailable");
  }
}

async function loadLiveStudioFacts() {
  const [catalog, services] = await Promise.allSettled([
    query(`SELECT sku, name, category_id, description, base_price, is_available
           FROM products WHERE is_available = TRUE AND is_archived = FALSE
           ORDER BY name`),
    listAvailableServices(),
  ]);
  const designs = catalog.status === "fulfilled" ? catalog.value.rows.map((product) => {
    try {
      const price = calculateItemPricing(product, 1);
      return {
        name: product.name,
        category: product.category_id,
        description: getApprovedDesign(product.sku)?.description || product.description,
        regularINR: price.basePrice,
        currentINR: price.unitPrice,
        offer: price.isPromoApplied ? price.promoName : null,
      };
    } catch {
      return { name: product.name, category: product.category_id, currentINR: null };
    }
  }) : null;
  const appointments = services.status === "fulfilled" ? services.value.map((service) => ({
    name: service.name,
    description: service.description,
    regularINR: service.basePrice,
    currentINR: service.effectivePrice,
    customQuote: service.isCustomQuote,
  })) : null;
  return JSON.stringify({ pressOnSets: designs, atHomeServices: appointments, appointmentSchedule: getBookingSchedule() });
}

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

  // The live catalogue is the sole source for the owner-approved replacements.
  const sections = knowledgeCache.sections.filter((section) => !getApprovedDesign(section.sku));
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
    console.error("[Divv] Gemini client is unconfigured");
    throw new DivvUnavailableError();
  }

  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    throw new TypeError("A message is required");
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
2. YOUR ROLE: You are the studio’s chat assistant. Divya is the artist who visits, paints and confirms bookings. Describe physical services with Divya as the subject (for example, "Divya fits and sculpts gel extensions at your home."). Never describe a service as something you personally do. For custom design quotes, availability or changes to an order, direct the customer to Divya. Answer routine shape, application and sizing questions directly.
3. CURRENT STUDIO FACTS: For purchasable press-ons, descriptions, availability, services, prices and offers use only LIVE STUDIO FACTS below. These override the knowledge base, product context and earlier conversation. Do not infer colours or finishes from product names. If a list or price is null, ask the customer to check the catalogue or confirm with Divya. Never infer a price or discount.
4. KEEP SERVICES DISTINCT: Press-ons ship across India and are applied at home by the customer. At-home appointments are a separate, in-person service in Delhi NCR. Use the live service names and starting prices. For a custom quote, hand off to Divya.
5. OFFERS: Mention offers only when the corresponding live row shows a lower current price than its regular price. Summarise a shared press-on offer only for the eligible sets. Never invent coupons, loyalty discounts, bundles, free delivery, or a fixed travel fee.
6. AT-HOME SALON SERVICE PROTOCOL (DELHI NCR):
   - If asked how extensions differ from press-ons: customers apply press-ons themselves. Divya fits and sculpts gel extensions at the customer’s home in Delhi NCR.
   - Use the live appointmentSchedule for hours, open weekdays, request windows and notice. openWeekdays uses 0 for Sunday through 6 for Saturday. Interpret calendar dates and times in Asia/Kolkata. Any exception must be proposed by staff and accepted by the customer.
   - Divya brings all professional equipment: electric drills, LED lamps, single-use files, sterilized implements, and soft gel collections directly to the client's home.
   - Appointments must be requested on the website or via WhatsApp and are confirmed personally by Divya. Divv cannot directly confirm bookings or schedule appointments.
7. PRESS-ON NAIL SIZING & CUSTOMIZATION:
   - Sets are available in 4 standard sizes: XS (14, 11, 12, 10, 8 mm), S (15, 12, 13, 11, 8 mm), M (16, 12, 13, 11, 9 mm), and L (17, 13, 14, 12, 10 mm) measured thumb-to-pinky.
   - Custom sizing is complimentary: Clients can select "Custom" and measure the widest part of their natural nail beds using tape and a millimeter ruler. Measure both hands, across the widest part of each nail. Compare each width to the chart and choose Custom if the measurements span more than one preset.
   - To submit measurements, open the set, choose "Choose your fit", select "Custom", and enter millimetre widths in the five sizing fields from thumb to pinky before adding it to the bag. If hands differ, enter one hand and share the other with Divya over WhatsApp. Customers can also leave the fields blank and send the measurements to Divya over WhatsApp. Offer Divya’s help checking the fit without promising a perfect fit.
   - Available shapes include Almond, Coffin, Square, Oval, and Stiletto.
8. PAN-INDIA DELIVERY & DISPATCH:
   - Press-on nails are handcrafted in Delhi NCR and shipped nationwide across India.
   - Same-day delivery in Delhi NCR requires Divya’s confirmation via WhatsApp. Only mention it if the customer asks about delivery timing.
   - Delivery charges are location-based and confirmed separately from product prices.
9. ORDER & PAYMENT INTEGRITY:
   - Divv is an AI Stylist and cannot verify payment status or mark orders as paid. Orders and payments are handled securely through verified studio checkout boundaries.
10. PORTFOLIO & DESIGNS:
   - Lookbook designs are inspiration. Divya can confirm whether an inspiration design can be made as a set or at an at-home appointment. Customers can send outfit pictures to Divya on WhatsApp. Divv cannot receive images in this chat.
11. PRODUCT NAMES FIRST (NEVER EXPOSE SKUS OR ALIAS LISTS):
   - Electric Lavender and Molten Chrome Ripple are retired. If asked, explain they are unavailable and suggest an active catalogue design.
   - Always use public Product Names (e.g., "Silver Petal", "Maharaja Velvet"). Never mention internal SKU codes (CAS-005, WED-008) unless the customer explicitly typed that SKU first.
12. RECOMMENDATIONS & STYLING GUIDANCE:
   - When asked what to buy, use the exact public names of up to three relevant sets from LIVE STUDIO FACTS. Give one short reason per design and, if useful, one short follow-up question. Let the product cards show prices unless the user asks for prices or offers. For a named set, quote its own live prices instead of estimating a range.
   - Use CURRENT PRODUCT CONTEXT when the customer refers to "this", "this design", or "this one".
13. CLEAN FORMATTING:
   - Use clean Markdown with bold prices and names (e.g., **₹1,499** base / **₹999** promotional) for clarity. Never output raw HTML tags.
${productContextText}${historyText}
--- LIVE STUDIO FACTS (INR) ---
${await loadLiveStudioFacts()}
--- END LIVE STUDIO FACTS ---
--- KNOWLEDGE DATABASE ---
${highlightsText}
${selectedKnowledgeXml}
--- END KNOWLEDGE DATABASE ---

Before you reply, apply these checks:
- Refer to Divya in the third person. She is the nail artist who visits customers. You are the chat assistant.
- For "what offers" questions, include only verified price reductions in LIVE STUDIO FACTS. Delivery, bundles and loyalty are outside the current offer list.
- The kit includes ten soft-gel nails, nail glue, 24 adhesive tabs, a cuticle pusher, a dual-grit buffer and one alcohol prep wipe. Use this list in place of older kit descriptions. Do not promise damage-free wear or a guaranteed duration.
- For custom fit, tell the customer to select Custom on the set and enter their nail widths in millimetres. If their hands differ, they can share the other hand's widths with Divya on WhatsApp. Divya checks the fit with them before painting the set.
- For application, describe clean, dry natural nails and following the directions for the chosen tab or glue. For removal, follow that adhesive's directions and never pull or pry the nails off. Do not prescribe one removal method for both adhesive types.
- Only quote a product price if the customer asks about price, offers or budget. When recommending designs, name the relevant sets and briefly describe why they fit. The cards show the verified prices.
- Only hand off when Divya must personally confirm something. For routine shape or sizing advice, give a practical answer and offer one relevant next step.`;

  const model = genAI.getGenerativeModel({
    model: CONFIG.geminiModel,
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.25, // Sleek balance of factual precision and warm luxury consultant tone
      topP: 0.85,
      maxOutputTokens: 1024,
    }
  });

  const backoff = [600, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await model.generateContent(userMessage, { timeout: 10000 });
      const reply = result.response.text().trim();
      if (reply) return reply;
      console.warn("[Divv] Gemini returned an empty reply");
      break;
    } catch (error) {
      const timedOut = error instanceof GoogleGenerativeAIAbortError;
      const status = Number.isInteger(error.status) ? error.status : null;
      console.warn("[Divv] Gemini request failed", { status, timedOut, attempt: attempt + 1 });
      if (attempt >= backoff.length || (!timedOut && ![502, 503, 504].includes(status))) break;
      await delay(backoff[attempt]);
    }
  }
  throw new DivvUnavailableError();
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
  DivvUnavailableError,
  initAiService,
  loadKnowledgeDatabase,
  reloadKnowledge,
  retrieveRelevantContext,
  generateChatReply,
  getKnowledgeStatus,
};
