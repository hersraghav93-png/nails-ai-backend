"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("dotenv").config = () => ({ parsed: {} });
process.env.GEMINI_API_KEY = "divv-test-only";
require("../src/db/pool").query = async () => ({
  rows: [
    { sku: "TEST-1", name: "Offer Set", category_id: "casual", base_price: "899", is_available: true },
    { sku: "TEST-2", name: "Regular Set", category_id: "casual", base_price: "499", is_available: true },
  ],
});
require("../src/services/bookingService").listAvailableServices = async () => [];

const { initAiService, generateChatReply, DivvUnavailableError } = require("../src/services/aiService");

test("Divv retries an upstream 503 with the same message and live pricing context", async (t) => {
  initAiService();
  const requests = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return Response.json({ error: { message: "busy" } }, { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: "The Offer Set is ₹599." }] } }] });
  });
  const reply = await generateChatReply("Does that set have an offer?", {
    history: [{ role: "user", content: "I am looking at the Offer Set." }],
  });
  assert.equal(reply, "The Offer Set is ₹599.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  const system = requests[0].systemInstruction.parts[0].text;
  assert.match(system, /I am looking at the Offer Set/);
  assert.match(system, /"regularINR":899,"currentINR":599,"offer":"Festive Offer/);
  assert.match(system, /"regularINR":499,"currentINR":499,"offer":null/);
  assert.match(system, /L \(17, 13, 14, 12, 10 mm\)/);
});

test("Divv stops after three transient failures and surfaces unavailability", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () =>
    Response.json({ error: { message: "busy" } }, { status: 503 }));
  await assert.rejects(generateChatReply("How do I measure my nails?"), DivvUnavailableError);
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("Divv avoids provider retries on quota errors and rejects an empty provider reply", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () =>
    Response.json({ error: { message: "quota" } }, { status: 429 }));
  await assert.rejects(generateChatReply("Show me almond sets."), DivvUnavailableError);
  assert.equal(fetchMock.mock.callCount(), 1);
  fetchMock.mock.mockImplementation(async () => Response.json({
    candidates: [{ content: { parts: [{ text: " " }] } }],
  }));
  await assert.rejects(generateChatReply("Show me almond sets."), DivvUnavailableError);
  assert.equal(fetchMock.mock.callCount(), 2);
});
