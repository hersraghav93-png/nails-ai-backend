const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { cleanText, extractKeywords, generateProductAliases } = require("../utils/helpers");

/**
 * ==========================================================================
 * CONTENT EXTRACTOR (`src/builder/extractor.js`)
 * Parses HTML DOM and JS registries to extract high-value customer-facing
 * knowledge while stripping decorative noise, navigation, and boilerplate.
 * ==========================================================================
 */

/**
 * Extracts product pricing dictionary (`PRODUCT_PRICES`) from frontend script files (`*.js`).
 * @param {string[]} jsFiles - Array of JS file paths
 * @returns {Object} Dictionary mapping SKUs to price strings, e.g. { "CAS-004": "₹899" }
 */
function extractPricingRegistry(jsFiles) {
  const prices = {};

  for (const jsPath of jsFiles) {
    try {
      const content = fs.readFileSync(jsPath, "utf-8");
      // Match PRODUCT_PRICES object inside script.js
      const match = content.match(/const\s+PRODUCT_PRICES\s*=\s*\{([\s\S]*?)\};/);
      if (match && match[1]) {
        const body = match[1];
        // Extract key-value pairs like "CAS-004": "₹899"
        const regex = /["']([A-Z0-9-]+)["']\s*:\s*["']([^"']+)["']/g;
        let pair;
        while ((pair = regex.exec(body)) !== null) {
          prices[pair[1].trim()] = pair[2].trim();
        }
      }
    } catch (err) {
      console.warn(`[Extractor Warning] Could not parse pricing from ${jsPath}:`, err.message);
    }
  }

  return prices;
}

/**
 * Parses an HTML file to extract structured customer-facing knowledge sections.
 * @param {string} htmlFilePath - Absolute path to HTML file
 * @param {Object} pricingRegistry - Dictionary of SKU -> Price mappings
 * @returns {Array<Object>} Array of structured knowledge chunks
 */
function extractHtmlKnowledge(htmlFilePath, pricingRegistry = {}) {
  const sections = [];
  const fileName = path.basename(htmlFilePath);

  let htmlContent;
  try {
    htmlContent = fs.readFileSync(htmlFilePath, "utf-8");
  } catch (err) {
    console.error(`[Extractor Error] Could not read ${htmlFilePath}:`, err.message);
    return sections;
  }

  const $ = cheerio.load(htmlContent);

  // 1. Remove noisy elements (`Extract Only Useful Content`)
  $("script, style, noscript, svg, link, meta, header#site-header, footer#site-footer, .nav-menu, .mobile-nav-menu").remove();

  // Remove decorative or hidden elements EXCEPT inside FAQs or modals where answers/content might start hidden by JS
  $("[aria-hidden='true']").each((_, el) => {
    const $el = $(el);
    if (
      !$el.closest(".faq-item").length &&
      !$el.closest(".trust-faq-accordion-wrapper").length &&
      !$el.closest(".modal-overlay").length &&
      !$el.hasClass("trust-faq-accordion-wrapper")
    ) {
      $el.remove();
    }
  });

  // 2. Extract Major Sections (<section>)
  $("section").each((idx, el) => {
    const $sec = $(el);
    const secId = $sec.attr("id") || `section-${idx + 1}`;
    const secClass = $sec.attr("class") || "";

    // Determine category based on class/id
    let category = "General Information";
    if (secId === "home" || secClass.includes("hero")) category = "Brand Overview & Service Pillars";
    else if (secId === "about" || secClass.includes("manifesto")) category = "Brand Philosophy & Craftsmanship";
    else if (secId === "shop" || secClass.includes("shop")) category = "Press-On Nail Collections & Pricing";
    else if (secId === "portfolio" || secClass.includes("portfolio")) category = "Portfolio & Craftsmanship Quality";
    else if (secId === "services" || secClass.includes("services")) category = "Services Architecture (Press-Ons & At-Home Appointments)";
    else if (secId === "trust" || secClass.includes("trust")) category = "Why Choose Us & Customer FAQs";
    else if (secId === "reviews" || secClass.includes("reviews")) category = "Client Reviews & Testimonials";
    else if (secId === "contact" || secClass.includes("contact")) category = "Contact Information & Studio Hours";

    // If this is the Shop section (`#shop`), specifically extract each product card cleanly
    if (secId === "shop" || secClass.includes("shop")) {
      $sec.find(".carousel-card, article[data-product-sku]").each((_, cardEl) => {
        const $card = $(cardEl);
        const sku = $card.attr("data-product-sku") || "";
        const title = cleanText($card.find("h4").text()) || "Press-On Nail Set";
        const desc = cleanText($card.find("p").not(".product-price, .product-meta").last().text());
        const price = pricingRegistry[sku] || cleanText($card.find(".product-price").text()) || "Chat with the Artist for exact pricing";

        if (title && sku) {
          const aliases = generateProductAliases(title, desc, sku);
          const content = `Product Name: ${title}\nPrice: ${price}\nDescription: ${desc}\nCustomization: Handmade fresh to order with 100% tailored fit. Length, shape, and design can be customized upon confirmed order.\nInternal SKU: ${sku} (NOTE: For internal lookup only. Never mention SKU "${sku}" to the customer unless they explicitly typed it first.)`;
          sections.push({
            id: `${fileName}#shop-${sku}`,
            page: fileName,
            section: "shop-products",
            title: `${title} - ${price}`,
            productName: title,
            sku: sku,
            price: price,
            aliases: aliases,
            category: "Products & Press-On Pricing",
            content,
            keywords: extractKeywords(title, desc, price, "press-on", "order", "whatsapp", ...aliases)
          });
        }
      });
      // Also extract the shop header overview
      const shopHeading = cleanText($sec.find("h2").text()) || "Handmade Press-On Nail Collections";
      const shopIntro = cleanText($sec.find(".section-intro, .shop-subtitle").text()) || "Explore our casual, party, wedding, and daily wear press-on collections delivered across India.";
      sections.push({
        id: `${fileName}#shop-overview`,
        page: fileName,
        section: "shop-overview",
        title: shopHeading,
        category: "Products & Press-On Pricing",
        content: `Nails by Divya Press-On Collections: ${shopIntro}\nEvery set is custom hand-painted after your order is confirmed using professional soft gel. Order directly via WhatsApp.`,
        keywords: extractKeywords(shopHeading, shopIntro, "collection", "pricing", "press-on")
      });
      return; // Handled `#shop` via detailed product extraction
    }

    // If this is the Trust/FAQ section (`#trust`), specifically extract each of the 17 FAQ items individually!
    if (secId === "trust" || secClass.includes("trust")) {
      // First extract the 4 Core Trust Pillars
      $sec.find(".trust-card").not(".trust-card-faq").each((cIdx, cardEl) => {
        const $card = $(cardEl);
        const num = cleanText($card.find(".trust-number").text());
        const cardTitle = cleanText($card.find("h3").text());
        const cardBody = cleanText($card.find("p").text());
        if (cardTitle && cardBody) {
          sections.push({
            id: `${fileName}#trust-pillar-${cIdx + 1}`,
            page: fileName,
            section: "trust-reassurance",
            title: `Why Choose Nails by Divya: ${cardTitle} (${num})`,
            category: "Craftsmanship & Quality Standards",
            content: `${cardTitle}: ${cardBody}`,
            keywords: extractKeywords(cardTitle, cardBody, "quality", "handmade", "soft gel", "tailored fit")
          });
        }
      });

      // Next extract every single FAQ item inside the Concierge Accordion (`05 / Questions Before You Order`)
      $sec.find(".faq-item").each((fIdx, faqEl) => {
        const $faq = $(faqEl);
        const qText = cleanText($faq.find(".faq-question-text").text()) || `FAQ #${fIdx + 1}`;
        const aText = cleanText($faq.find(".faq-item-answer").text());
        if (qText && aText) {
          sections.push({
            id: `${fileName}#faq-${fIdx + 1}`,
            page: fileName,
            section: "customer-faq",
            title: qText,
            category: "Customer Frequently Asked Questions (FAQ)",
            content: `Question: ${qText}\nAnswer: ${aText}`,
            keywords: extractKeywords(qText, aText, "faq", "question", "answer")
          });
        }
      });
      return; // Handled `#trust` and `#faq` cleanly
    }

    // If this is Client Reviews (`#reviews`), extract reviews cleanly
    if (secId === "reviews" || secClass.includes("reviews")) {
      const reviewOverviewTitle = cleanText($sec.find("h2").text()) || "Loved by Our Clients — Authentic Google Reviews";
      let allReviewsText = "";
      $sec.find(".review-card").each((_, revEl) => {
        const $rev = $(revEl);
        const quote = cleanText($rev.find(".review-quote").text());
        const author = cleanText($rev.find(".author-name").text());
        const context = cleanText($rev.find(".author-context").text());
        if (quote && author) {
          allReviewsText += `★★★★★ Review by ${author} (${context}): "${quote}"\n\n`;
        }
      });
      if (allReviewsText) {
        sections.push({
          id: `${fileName}#client-reviews`,
          page: fileName,
          section: "client-reviews",
          title: reviewOverviewTitle,
          category: "Client Reviews & Testimonials",
          content: `Real Client Testimonials from Google Reviews for Nails by Divya:\n\n${allReviewsText.trim()}`,
          keywords: extractKeywords(reviewOverviewTitle, allReviewsText, "reviews", "client", "google", "feedback")
        });
      }
      return;
    }

    // Default extraction for general sections (`#home`, `#about`, `#services`, `#contact`, etc.)
    const heading = cleanText($sec.find("h1, h2, h3").first().text()) || `Section: ${category}`;
    // Clone section, remove inner cards/FAQs that might have been processed or would clutter
    const $clone = $sec.clone();
    $clone.find("button, .faq-list, .carousel-track").remove();
    const bodyText = cleanText($clone.text());

    if (bodyText.length > 30) {
      sections.push({
        id: `${fileName}#${secId}`,
        page: fileName,
        section: secId,
        title: heading,
        category,
        content: bodyText,
        keywords: extractKeywords(heading, bodyText, category)
      });
    }
  });

  // 3. Extract Modal Details (#product-modal, #service-modal) for complete guarantee & box contents
  $("#product-modal, #service-modal").each((_, modalEl) => {
    const $m = $(modalEl);
    const mId = $m.attr("id");
    const title = cleanText($m.find("h2, .modal-title").text()) || (mId === "product-modal" ? "Press-On Order Guarantee & What's Included" : "At-Home Studio Service Details & Guarantee");
    const text = cleanText($m.find(".modal-description, .modal-highlights, .modal-guarantee, p").text());
    if (text.length > 20) {
      sections.push({
        id: `${fileName}#${mId}`,
        page: fileName,
        section: mId,
        title,
        category: mId === "product-modal" ? "Press-On Nail Information & Kit Contents" : "At-Home Service & Appointment Protocol",
        content: `${title}\n${text}`,
        keywords: extractKeywords(title, text, "guarantee", "included", "kit", "application", "studio")
      });
    }
  });

  return sections;
}

module.exports = {
  extractPricingRegistry,
  extractHtmlKnowledge
};
