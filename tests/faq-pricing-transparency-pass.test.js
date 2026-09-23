// Regression test for the FAQ / pricing-transparency content pass
// (2026-09-23): homepage FAQ section added, pricing.html got 3 new
// objection-handling FAQs, dumpster-rental.html's prohibited-materials FAQ
// got a food-waste line plus one new FAQ, and furniture-removal.html's
// upstairs-stairs FAQ was reworded to remove language that implied a stair
// surcharge. Guards against the visible copy and the FAQPage JSON-LD
// silently drifting apart, and against the verified $125/ton dumpster
// overweight rate (and the other dumpster terms) being changed by mistake.
//
// This only reads public HTML files — it makes no network calls and touches
// no admin/API code.
//
// Run with:  node tests/faq-pricing-transparency-pass.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SITE_DIR = path.join(__dirname, "..");

function readPage(rel) {
  return fs.readFileSync(path.join(SITE_DIR, rel), "utf8");
}

function extractGraph(content, rel) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(content))) blocks.push(m[1]);
  let graph = [];
  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${rel}: JSON-LD block failed to parse: ${e.message}`);
    }
    graph = graph.concat(Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);
  }
  return graph;
}

function faqPageOf(content, rel) {
  const graph = extractGraph(content, rel);
  const faqNodes = graph.filter((n) => n && n["@type"] === "FAQPage");
  assert.strictEqual(faqNodes.length, 1, `${rel}: expected exactly 1 FAQPage node, found ${faqNodes.length}`);
  return faqNodes[0];
}

function visibleFaqPairs(content) {
  const bodyStart = content.indexOf("<body>");
  const body = content.slice(bodyStart);
  const pairRe = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p class="text-muted"[^>]*>([\s\S]*?)<\/p>/g;
  const pairs = [];
  let pm;
  while ((pm = pairRe.exec(body))) {
    pairs.push({
      question: pm[1].trim(),
      answer: pm[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    });
  }
  return pairs;
}

function assertVisibleMatchesSchema(rel, content) {
  const faq = faqPageOf(content, rel);
  const visible = visibleFaqPairs(content);
  for (const q of faq.mainEntity) {
    const match = visible.find((v) => v.question === q.name);
    assert.ok(match, `${rel}: schema question not found verbatim in visible HTML: "${q.name}"`);
    const schemaAnswer = q.acceptedAnswer.text.replace(/\s+/g, " ").trim();
    assert.strictEqual(
      match.answer,
      schemaAnswer,
      `${rel}: visible answer text does not match FAQPage schema for "${q.name}"`
    );
  }
  return faq;
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// ---------------------------------------------------------------------

test("index.html: visible FAQ text matches FAQPage schema exactly, no duplicate FAQPage node", () => {
  const content = readPage("index.html");
  assertVisibleMatchesSchema("index.html", content);
});

test("index.html: homepage FAQ carries exactly the 5 approved questions", () => {
  const content = readPage("index.html");
  const faq = faqPageOf(content, "index.html");
  const names = faq.mainEntity.map((q) => q.name);
  assert.deepStrictEqual(names, [
    "How is junk removal priced?",
    "Do you charge extra for stairs?",
    "Do I need to move everything outside before you arrive?",
    "Do you offer same-day junk removal?",
    "What happens to items that are still usable?",
  ]);
});

test("index.html: homepage FAQ does not claim every item is donated/recycled (no unsupported guarantee)", () => {
  const content = readPage("index.html");
  const faq = faqPageOf(content, "index.html");
  const donationAnswer = faq.mainEntity.find((q) => q.name === "What happens to items that are still usable?").acceptedAnswer.text;
  assert.ok(/when practical/i.test(donationAnswer), "answer should be hedged with 'when practical'");
  assert.ok(!/every item|everything is donated|100%/i.test(donationAnswer), "answer must not promise every item is donated/recycled");
});

test("pricing.html: visible FAQ text matches FAQPage schema exactly, no duplicate FAQPage node", () => {
  const content = readPage("pricing.html");
  assertVisibleMatchesSchema("pricing.html", content);
});

test("pricing.html: the 3 new objection-handling FAQs are present in the schema", () => {
  const content = readPage("pricing.html");
  const faq = faqPageOf(content, "pricing.html");
  const names = faq.mainEntity.map((q) => q.name);
  for (const q of [
    "Will my price change when you arrive?",
    "What if my junk takes up less space than estimated?",
    "Do you charge extra for stairs?",
  ]) {
    assert.ok(names.includes(q), `pricing.html: expected new FAQ "${q}" in FAQPage schema`);
  }
});

test("dumpster-rental.html: visible FAQ text matches FAQPage schema exactly, no duplicate FAQPage node", () => {
  const content = readPage("dumpster-rental.html");
  assertVisibleMatchesSchema("dumpster-rental.html", content);
});

test("dumpster-rental.html: prohibited-materials FAQ gained the food-waste line and kept prior material list intact", () => {
  const content = readPage("dumpster-rental.html");
  const faq = faqPageOf(content, "dumpster-rental.html");
  const answer = faq.mainEntity.find((q) => q.name === "What can't go in the dumpster?").acceptedAnswer.text;
  assert.ok(/excessive food waste is also not permitted/i.test(answer), "must mention the excessive-food-waste restriction");
  assert.ok(/asbestos/i.test(answer) && /Freon|refrigerant appliances/i.test(answer), "must preserve prior prohibited-material list");
});

test("dumpster-rental.html: new junk-removal-vs-dumpster FAQ is present", () => {
  const content = readPage("dumpster-rental.html");
  const faq = faqPageOf(content, "dumpster-rental.html");
  assert.ok(
    faq.mainEntity.some((q) => q.name === "Should I choose junk removal or a dumpster rental?"),
    "expected the new junk-removal-vs-dumpster-rental FAQ"
  );
});

test("dumpster-rental.html: base price/term numbers are unchanged ($349, 5 days, 2 tons, $125/ton overage, $15/day extra)", () => {
  const content = readPage("dumpster-rental.html");
  assert.ok(content.includes("$349"), "flat base price must remain $349");
  assert.ok(/up to 5 calendar days|5 days/i.test(content), "included rental period must remain 5 days");
  assert.ok(content.includes("2 tons") || content.includes("2 tons (4,000 lbs)"), "included weight must remain 2 tons");
  assert.ok(content.includes("$125 per additional ton"), "overweight rate must remain $125/ton");
  assert.ok(content.includes("$15 each") || content.includes("$15/day"), "extra-day rate must remain $15/day");
  assert.ok(!content.includes("$90"), "stale $90/ton figure must not appear anywhere on this page");
});

test("pricing.html: dumpster overweight rate is $125/ton, not the stale $90/ton figure", () => {
  const content = readPage("pricing.html");
  assert.ok(content.includes("$125 per additional ton"), "pricing.html must state the $125/ton overweight rate");
  assert.ok(!content.includes("$90"), "stale $90/ton figure must not appear on pricing.html");
});

test("furniture-removal.html: visible FAQ text matches FAQPage schema exactly, no duplicate FAQPage node", () => {
  const content = readPage("furniture-removal.html");
  assertVisibleMatchesSchema("furniture-removal.html", content);
});

test("furniture-removal.html: upstairs-bedroom FAQ no longer implies a stair surcharge, and states there is no separate stair fee", () => {
  const content = readPage("furniture-removal.html");
  const faq = faqPageOf(content, "furniture-removal.html");
  const answer = faq.mainEntity.find(
    (q) => q.name === "Can you get furniture out of an upstairs bedroom or a walk-up apartment?"
  ).acceptedAnswer.text;
  assert.ok(!/factored into the quote/i.test(answer), "must no longer say stairs are 'factored into the quote' (implies a surcharge)");
  assert.ok(/don't charge a separate fee/i.test(answer), "must state there is no separate stair fee");
});

test("furniture-removal.html: 'What affects the price' body copy no longer names stairs as a factor that adds time (contradicted the no-stair-fee FAQ), but keeps carry-distance as a legitimate factor for an unusually long carry", () => {
  const content = readPage("furniture-removal.html");
  const match = content.match(/<b>What affects the price:<\/b>([\s\S]*?)<\/p>/);
  assert.ok(match, "expected the 'What affects the price' paragraph to exist in the Priced by trailer space section");
  const text = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  assert.ok(!/stairs/i.test(text), "must not single out stairs as a price/time factor — contradicts the no-separate-stair-fee policy");
  assert.ok(/unusually long carry/i.test(text), "must still acknowledge an unusually long carry can add time (unusual jobs can still affect scope)");
  assert.ok(/how many pieces you have/i.test(text) && /disassembled/i.test(text), "must preserve the other two existing price factors unchanged");
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
