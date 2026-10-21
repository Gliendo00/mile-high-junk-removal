// CRM-only UX fix (2026-10-12): Schedule's job cards gained a directly
// clickable status pill (tap it to change a job's status without opening
// the job detail page), and completing a job from Schedule now opens the
// exact same Payment + Tip + How'd it go? closeout sheet
// admin/booking-detail.js's own Status control uses — one shared
// implementation (admin/job-closeout.js), reused by both pages, not a
// second Schedule-specific copy of the status/payment logic.
//
// Same approach as every other client-admin-JS test in this suite (see
// e.g. tests/phase3c-client-typeahead.test.js's own header): this project
// has no jsdom/DOM-execution harness for these particular files, so
// structure/behavior is verified by inspecting the real, unmodified source
// text rather than executing it.
//
// Run with:  node tests/crm-schedule-inline-status-closeout.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function readSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8").replace(/\r\n/g, "\n");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Static wiring — the new shared module loads everywhere it's needed,
//    in an order that actually works (status-ui.js/job-closeout.js before
//    the page script that calls into them).
// =======================================================================
test("admin/index.html (Schedule) loads status-ui.js and job-closeout.js BEFORE schedule.js, and has the #admin-toast element the new status/closeout feedback needs", () => {
  const html = readSrc("admin/index.html");
  const statusUiIdx = html.indexOf('<script src="status-ui.js">');
  const closeoutIdx = html.indexOf('<script src="job-closeout.js">');
  const scheduleIdx = html.indexOf('<script src="schedule.js">');
  assert.ok(statusUiIdx !== -1, "must load status-ui.js");
  assert.ok(closeoutIdx !== -1, "must load job-closeout.js");
  assert.ok(scheduleIdx !== -1, "must load schedule.js");
  assert.ok(statusUiIdx < scheduleIdx, "status-ui.js must load before schedule.js uses window.AdminStatusUI");
  assert.ok(closeoutIdx < scheduleIdx, "job-closeout.js must load before schedule.js uses window.AdminJobCloseout");
  assert.ok(html.includes('id="admin-toast"'), "Schedule needs its own toast element for status/closeout feedback, same as booking-detail.js");
});

test("admin/booking/index.html loads job-closeout.js (booking-detail.js's completion flow now depends on it)", () => {
  const html = readSrc("admin/booking/index.html");
  assert.ok(/<script src="\.\.\/job-closeout\.js"><\/script>/.test(html));
});

// =======================================================================
// 2. admin/schedule.js — clickable status pill: structure, routing, reuse
// =======================================================================
test("admin/schedule.js: the status pill is a real <button>, built and appended to the card BEFORE the 'open detail' anchor exists — never nested inside it", () => {
  const src = readSrc("admin/schedule.js");
  const fnStart = src.indexOf("function renderJobCard");
  assert.ok(fnStart !== -1);
  // Window widened 3600 -> 4200 (audit fix, 2026-10-21): admin/schedule.js's
  // Dashboard Revenue audit fix added an explanatory comment earlier in
  // this same function (the Actual Collected price label now reads
  // job.revenueAmount) — pure comment/content growth, not a reordering —
  // which pushed card.appendChild(main) past the old fixed window.
  const fnBody = src.slice(fnStart, fnStart + 4200);

  const statusBtnIdx = fnBody.indexOf("var statusBtn = document.createElement('button')");
  const topAppendIdx = fnBody.indexOf("card.appendChild(top)");
  const mainCreateIdx = fnBody.indexOf("var main = document.createElement('a')");
  assert.ok(statusBtnIdx !== -1, "the status button must be created");
  assert.ok(topAppendIdx !== -1, "the row holding it must be appended to the card directly");
  assert.ok(mainCreateIdx !== -1, "the 'open detail' anchor must still exist");
  assert.ok(statusBtnIdx < topAppendIdx, "status button must be built before its row is attached to the card");
  assert.ok(topAppendIdx < mainCreateIdx, "the status row must be attached to the card BEFORE the anchor is even created, proving it's a sibling, not a descendant of the anchor");

  // The anchor's own construction, up to where it's appended to the card,
  // must never reference the status button/label — i.e. it was never
  // placed inside the anchor.
  const cardAppendMainIdx = fnBody.indexOf("card.appendChild(main)");
  assert.ok(cardAppendMainIdx !== -1);
  const mainBuildSlice = fnBody.slice(mainCreateIdx, cardAppendMainIdx);
  assert.ok(!/statusBtn|statusLabelEl/.test(mainBuildSlice), "the anchor's own construction must never reference the status button — it must be a sibling, not nested inside the <a>");
});

test("admin/schedule.js: the status button reuses .admin-status-badge/.admin-status-trigger, the SAME classes admin/booking/index.html's status control uses — not a new visual language", () => {
  const src = readSrc("admin/schedule.js");
  assert.ok(/statusBtn\.className = 'admin-status-badge admin-status-' \+ job\.status \+ ' admin-status-trigger'/.test(src));
});

test("admin/schedule.js: tapping the status pill opens the SAME window.AdminStatusUI sheet admin/booking-detail.js uses, with the identical rental_out-only-for-dumpster-rental filter", () => {
  const src = readSrc("admin/schedule.js");
  const fnStart = src.indexOf("function openJobStatusSheet");
  assert.ok(fnStart !== -1);
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.ok(/window\.AdminStatusUI\.STATUS_ORDER\.filter/.test(fnBody));
  assert.ok(/key !== 'rental_out' \|\| job\.serviceType === 'dumpster_rental'/.test(fnBody));
  assert.ok(/window\.AdminStatusUI\.open\(/.test(fnBody));
});

test("admin/schedule.js: picking 'Completed' routes to the shared closeout (window.AdminJobCloseout), every OTHER status saves immediately via its own PATCH — never the other way around", () => {
  const src = readSrc("admin/schedule.js");
  const fnStart = src.indexOf("function openJobStatusSheet");
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.ok(/if \(newStatus === job\.status\) return;/.test(fnBody), "re-picking the current status must be a no-op");
  assert.ok(/if \(newStatus === 'completed'\) \{\s*openScheduleCloseout\(job\);/.test(fnBody));
  assert.ok(/\} else \{\s*saveJobStatus\(job, newStatus, statusBtn\);/.test(fnBody));

  assert.ok(/function openScheduleCloseout\(job\) \{\s*window\.AdminJobCloseout\.open\(/.test(src), "Completed must open the SHARED closeout module, not a Schedule-specific sheet");
  assert.ok(!/function.*[Cc]loseout.*\{[\s\S]*admin-sheet-overlay/.test(src.slice(0, src.indexOf("function openScheduleCloseout"))), "schedule.js must never build its own closeout sheet DOM");
});

test("admin/schedule.js: non-completed status changes PATCH the exact same endpoint booking-detail.js uses (resource=status), then refresh the current view — not left stale", () => {
  const src = readSrc("admin/schedule.js");
  assert.ok(/adminFetch\('\/api\/admin\/booking\?resource=status'/.test(src));
  const saveFnStart = src.indexOf("function saveJobStatus");
  const saveFnBody = src.slice(saveFnStart, saveFnStart + 900);
  assert.ok(/refreshCurrentView\(\)/.test(saveFnBody), "a successful status save must refresh the visible Schedule list");
  // A failed save must NOT refresh (nothing changed server-side) and must
  // surface an error toast instead.
  const catchSlice = saveFnBody.slice(saveFnBody.indexOf(".catch("), saveFnBody.indexOf(".finally("));
  assert.ok(/showToast\(/.test(catchSlice));
  assert.ok(!/refreshCurrentView\(\)/.test(catchSlice), "a failed status save must never refresh the view as if it had succeeded");
});

test("admin/schedule.js: a successful Schedule closeout refreshes the view; cancelling or a failed closeout must not (the shared module itself guarantees cancel sends nothing)", () => {
  const src = readSrc("admin/schedule.js");
  const fnStart = src.indexOf("function openScheduleCloseout");
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.ok(/onComplete: function \(result\) \{/.test(fnBody));
  assert.ok(/refreshCurrentView\(\);/.test(fnBody));
  // onComplete is the ONLY callback schedule.js supplies — no onCancel/
  // onStatusError handling needed here, since nothing on this page was
  // touched before a confirmed success (same reasoning as
  // booking-detail.js's own openCompletionCloseout()).
  assert.ok(!/onCancel\s*:/.test(fnBody));
});

test("admin/schedule.js never uses innerHTML/insertAdjacentHTML/document.write, including in the new status/closeout code", () => {
  const src = readSrc("admin/schedule.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// =======================================================================
// 3. admin/job-closeout.js — the shared module itself
// =======================================================================
test("admin/job-closeout.js exposes window.AdminJobCloseout.open()/.close(), same pattern as window.AdminStatusUI", () => {
  const src = readSrc("admin/job-closeout.js");
  assert.ok(/window\.AdminJobCloseout = \(function \(\) \{/.test(src));
  assert.ok(/return \{ open: open, close: close \};/.test(src));
});

test("admin/job-closeout.js: Payment is optional as a whole (only validated once an amount is actually entered), and 'Other' requires a description — mirroring the standalone Record Payment control's own rule exactly", () => {
  const src = readSrc("admin/job-closeout.js");
  assert.ok(/if \(amountRaw !== ''\) \{/.test(src), "an empty amount field must skip payment entirely, never force one");
  assert.ok(/method === 'other' && !paymentNotes/.test(src));
});

test("admin/job-closeout.js: payment methods match admin/booking/index.html's #d-payment-method-select exactly (card_stripe never offered)", () => {
  const src = readSrc("admin/job-closeout.js");
  const html = readSrc("admin/booking/index.html");
  const htmlOptions = Array.from(html.matchAll(/<option value="([a-z_]+)">/g)).map((m) => m[1]);
  // Only compare against the Record Payment select's own options, not the
  // page's other <select> (Archive Reason also isn't in this file, so this
  // is safe) — anchor on the payment-method id directly.
  const selectStart = html.indexOf('id="d-payment-method-select"');
  const selectEnd = html.indexOf("</select>", selectStart);
  const selectHtml = html.slice(selectStart, selectEnd);
  const paymentMethodOptions = Array.from(selectHtml.matchAll(/<option value="([a-z_]+)">/g)).map((m) => m[1]);
  const closeoutMethods = Array.from(src.matchAll(/\{ value: '([a-z_]+)', label:/g)).map((m) => m[1]);
  assert.deepStrictEqual(closeoutMethods.sort(), paymentMethodOptions.sort());
  assert.ok(!closeoutMethods.includes("card_stripe"), "card_stripe must never be manually selectable");
  void htmlOptions;
});

test("admin/job-closeout.js: Tip and the operational note stay optional with an explicit Cancel; Cancel sends no network request at all", () => {
  const src = readSrc("admin/job-closeout.js");
  const cancelStart = src.indexOf("cancelBtn.addEventListener('click'");
  const cancelBody = src.slice(cancelStart, cancelStart + 200);
  assert.ok(/close\(\);/.test(cancelBody));
  assert.ok(/if \(opts\.onCancel\) opts\.onCancel\(\);/.test(cancelBody));
  assert.ok(!/adminFetch/.test(cancelBody), "Cancel must never call adminFetch");
});

test("admin/job-closeout.js: the status PATCH must succeed before payment/tip are ever attempted — both chained inside its own .then(), and a status failure never calls submitPayment/submitTip", () => {
  const src = readSrc("admin/job-closeout.js");
  const confirmStart = src.indexOf("confirmBtn.addEventListener('click'");
  const confirmBody = src.slice(confirmStart, src.indexOf("overlay.removeAttribute('hidden');"));
  const statusCallIdx = confirmBody.indexOf("patchStatusCompleted(bookingId, operationalNote || null)");
  const thenIdx = confirmBody.indexOf(".then(function (body)", statusCallIdx);
  const paymentCallIdx = confirmBody.indexOf("submitPayment(bookingId, payment)");
  const tipCallIdx = confirmBody.indexOf("submitTip(bookingId, tipAmount)");
  const catchIdx = confirmBody.indexOf(".catch(function (err)", statusCallIdx);
  assert.ok(statusCallIdx !== -1 && thenIdx !== -1 && paymentCallIdx !== -1 && tipCallIdx !== -1 && catchIdx !== -1);
  assert.ok(statusCallIdx < thenIdx && thenIdx < paymentCallIdx && paymentCallIdx < tipCallIdx && tipCallIdx < catchIdx, "payment/tip must be built INSIDE the status PATCH's own success .then(), both before the shared .catch()");
});

test("admin/job-closeout.js: a payment-save failure or tip-save failure is reported back via the result object, never thrown — the job stays completed and the sheet still closes", () => {
  const src = readSrc("admin/job-closeout.js");
  assert.ok(/result\.paymentError = \(err && err\.message\) \|\| 'Could not save the payment\.';/.test(src));
  assert.ok(/result\.tipError = \(err && err\.message\) \|\| 'Could not save the tip\.';/.test(src));
  // Both submitPayment/submitTip calls catch their own rejection with a
  // second .then() handler (not a thrown error that would skip close()).
  const chainSlice = src.slice(src.indexOf("var chain = Promise.resolve();"), src.indexOf("return chain.then(function () {"));
  assert.ok(/submitPayment\(bookingId, payment\)\.then\(\s*function \(\) \{ result\.paymentSaved = true; \},/.test(chainSlice));
  assert.ok(/submitTip\(bookingId, tipAmount\)\.then\(\s*function \(\) \{ result\.tipSaved = true; \},/.test(chainSlice));
});

test("admin/job-closeout.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const src = readSrc("admin/job-closeout.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
  assert.ok(!/document\.write\s*\(/.test(src));
});

// =======================================================================
// 4. admin/booking-detail.js — reuses the shared module, no leftover dead
//    code from the old page-local closeout sheet
// =======================================================================
test("admin/booking-detail.js's openCompletionCloseout() reports payment/tip outcomes the same way schedule.js does (symmetric UX, not a drifting second implementation of the messaging)", () => {
  const src = readSrc("admin/booking-detail.js");
  const fnStart = src.indexOf("function openCompletionCloseout");
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.ok(/window\.AdminJobCloseout\.open\(\{/.test(fnBody));
  assert.ok(/bookingId: bookingId,/.test(fnBody));
  assert.ok(/applyStatusDisplay\(result\.status\);/.test(fnBody));
  assert.ok(/reloadJobPayments\(\);/.test(fnBody), "the Payments section (Collected/Tip/notes) must refresh after a closeout, so a saved payment/tip is immediately visible");
});

// =======================================================================
// 5. Scope guard — the temporary local-verification mock used to visually
//    confirm this feature in a browser without a real authenticated
//    Supabase session (same established pattern as this project's own
//    prior admin/_dev-mock.js uses) must never ship.
// =======================================================================
test("the temporary admin/_dev-mock.js verification helper is gone, and admin/index.html no longer references it", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "admin", "_dev-mock.js")), "admin/_dev-mock.js must be deleted before committing");
  const html = readSrc("admin/index.html");
  assert.ok(!html.includes("_dev-mock.js"));
});

test("admin/booking-detail.js no longer defines the old page-local closeout sheet (DOM-building code), only the slim reuse wrapper", () => {
  const src = readSrc("admin/booking-detail.js");
  assert.ok(!/ensureCloseoutSheetDom/.test(src));
  assert.ok(!/clearCloseoutSheet/.test(src));
  assert.ok(!/closeCloseoutSheet/.test(src));
  assert.ok(!/closeoutOverlay/.test(src));
  assert.ok(!/closeoutSheet\b/.test(src));
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("ok - " + t.name);
    } catch (err) {
      failed++;
      console.error("FAIL - " + t.name);
      console.error(err);
    }
  }
  if (failed) process.exitCode = 1;
}

main();
