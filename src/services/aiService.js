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
4. REGULAR PRICING VS PROMOTIONS: Always clearly distinguish between regular catalog prices and active promotional offers:
   - Regular catalog prices for press-on sets range from ₹699 to ₹1399 across 22 catalog designs (for example, Maharaja Velvet is ₹699 regular catalog price; Leopard French is ₹799 regular price).
   - Active Diwali festive promotions include:
     1. Home Service from ₹999 across Delhi NCR (Delhi, Gurgaon, Noida).
     2. Press-on Nails starting from ₹599 delivered across India.
     3. Buy 2 Press-On Sets, Get 1 Set FREE (3rd set is complimentary).
     4. First Order: 10% OFF welcome discount for new customers.
     5. Returning Clients: 15% OFF loyalty discount.
     6. Same-Day Delivery available in Delhi NCR.
5. PROMOTION STACKING / COMBINING DISCOUNTS: When asked if two discounts or offers can be combined (for example, combining 10% off with Buy 2 Get 1 Free), you MUST state that the website does not specify whether discounts can be stacked or combined, and invite the customer to chat with Divya on WhatsApp to confirm. Never invent stacking rules.
6. SAME-DAY DELIVERY: Same-day delivery is available ONLY in Delhi NCR. Outside Delhi NCR, standard Pan-India delivery applies. Delivery fees and cut-off times are unspecified on the website; confirm via WhatsApp.
7. AT-HOME SERVICES: Personal at-home nail appointments are available across Delhi NCR (Delhi, Gurgaon, Noida), starting from ₹999 during the festive edit. Services include soft gel extensions, overlays, and bespoke nail art.
8. PORTFOLIO DESIGNS: Nails by Divya features 60 bespoke portfolio designs in the lookbook across chrome, nude, bridal, and custom nail art. Each design can be ordered as handmade press-ons delivered across India or chosen as reference inspiration for an at-home appointment.
9. PRODUCT NAMES FIRST (NEVER EXPOSE SKUS OR ALIAS LISTS): When referring to products, ALWAYS use their exact public Product Name (for example, "Molten Chrome Ripple", "Leopard French", "Maharaja Velvet"). You MUST NEVER naturally mention, include, or expose internal product codes or SKUs (like CAS-004, WED-005, PAR-0011) unless the customer explicitly typed that exact SKU code first. You MUST NEVER recite or mention search aliases.
10. RECOMMENDATIONS (EXPLAIN WHY): Never dump the whole catalogue. When recommending designs to match what a customer is looking for, recommend 2 to 4 designs and explain WHY each is a great choice.
11. SMARTER CUSTOMER UNDERSTANDING & ALIASES: Customers often describe designs naturally using aliases, descriptive phrases, styles, finishes, colors, or typos. If the retrieved highlights point to a single matching product or portfolio design, answer directly and naturally.
12. PRODUCT AWARENESS: Use the CURRENT PRODUCT CONTEXT when the customer refers to "this", "this design", or "this one".
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

module.exports = {
  initAiService,
  loadKnowledgeDatabase,
  reloadKnowledge,
  retrieveRelevantContext,
  generateChatReply
};
