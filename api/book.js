// Vercel serverless function — creates a customer + booking (+ dumpster_rentals
// row when applicable) in Supabase from the /book/ multi-step form.
//
// Required environment variables (server-side only, never read by the browser):
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//   UPLOAD_TOKEN_SECRET — signs the short-lived photo-upload token (see below)
//
// Column names below match the live schema exactly:
//   customers(id, first_name, last_name, phone, email, address, city, state, zip, created_at)
//   bookings(id, customer_id, service_type, appointment_date, time_window, status,
//            description, estimated_price, final_price, internal_notes, created_at, updated_at)
//   dumpster_rentals(id, booking_id UNIQUE, delivery_date, pickup_date, material_type,
//                     placement_notes, created_at)
//   booking_photos(id, booking_id, storage_path, created_at) — written by api/upload-photo.js.
//
// On success this endpoint never returns the raw booking UUID. Instead it returns a
// short-lived, HMAC-signed "uploadToken" scoped to exactly this booking, which the
// browser presents to POST /api/upload-photo to attach photos. See verifyUploadToken
// in api/upload-photo.js for the corresponding verification logic (kept as a small,
// duplicated helper in both files rather than a shared module, matching this project's
// existing pattern of self-contained /api functions).

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SERVICE_TYPES = ["junk_removal", "dumpster_rental", "light_demo"];
const SERVICE_LABELS = { junk_removal: "Junk Removal", dumpster_rental: "15-Yard Dumpster Rental", light_demo: "Light Demo" };
const STAIRS_OPTIONS = ["none", "some", "multiple_flights"];
const STAIRS_LABELS = { none: "No stairs", some: "Some stairs", multiple_flights: "Multiple flights" };
const YES_NO = ["yes", "no"];
// Every accepted time-window value: its display label, and the America/Denver
// hour (0–23) it begins at — the latter drives the same-day expiration check
// in isTimeWindowExpired() below. "morning"/"midday"/"afternoon"/"evening" are
// the legacy broad windows, kept valid for any service type for backwards
// compatibility with bookings submitted before the 2-hour-window date & time
// UI shipped. The "w_*" ids are the current 2-hour windows.
const TIME_WINDOW_DEFS = {
  morning: { label: "Morning (8am–11am)", startHour: 8 },
  midday: { label: "Midday (11am–2pm)", startHour: 11 },
  afternoon: { label: "Afternoon (2pm–5pm)", startHour: 14 },
  evening: { label: "Evening (5pm–7pm)", startHour: 17 },
  w_0400_0600: { label: "4:00 AM – 6:00 AM", startHour: 4 },
  w_0600_0800: { label: "6:00 AM – 8:00 AM", startHour: 6 },
  w_0800_1000: { label: "8:00 AM – 10:00 AM", startHour: 8 },
  w_1000_1200: { label: "10:00 AM – 12:00 PM", startHour: 10 },
  w_1200_1400: { label: "12:00 PM – 2:00 PM", startHour: 12 },
  w_1400_1600: { label: "2:00 PM – 4:00 PM", startHour: 14 },
  w_1600_1800: { label: "4:00 PM – 6:00 PM", startHour: 16 },
  w_1800_2000: { label: "6:00 PM – 8:00 PM", startHour: 18 },
  w_2000_2200: { label: "8:00 PM – 10:00 PM", startHour: 20 },
};
const TIME_WINDOW_LABELS = Object.keys(TIME_WINDOW_DEFS).reduce(function (acc, id) {
  acc[id] = TIME_WINDOW_DEFS[id].label;
  return acc;
}, {});

const LEGACY_TIME_WINDOWS = ["morning", "midday", "afternoon", "evening"];
// Junk removal / light demo: the full 4am–10pm range.
const STANDARD_ARRIVAL_WINDOWS = [
  "w_0400_0600",
  "w_0600_0800",
  "w_0800_1000",
  "w_1000_1200",
  "w_1200_1400",
  "w_1400_1600",
  "w_1600_1800",
  "w_1800_2000",
  "w_2000_2200",
];
// Dumpster rental delivery: 6am–8pm only — no 4–6am or 8–10pm — matching
// DUMPSTER_DELIVERY_WINDOWS in book/book.js.
const DUMPSTER_DELIVERY_WINDOWS = STANDARD_ARRIVAL_WINDOWS.filter(function (id) {
  return id !== "w_0400_0600" && id !== "w_2000_2200";
});
// The time windows accepted per service type. Legacy values remain valid for
// every service type (they always were), but the new w_* windows are scoped
// per service so, e.g., a dumpster_rental booking cannot be submitted with a
// junk-removal-only window like 4–6am.
const TIME_WINDOWS_BY_SERVICE = {
  junk_removal: LEGACY_TIME_WINDOWS.concat(STANDARD_ARRIVAL_WINDOWS),
  light_demo: LEGACY_TIME_WINDOWS.concat(STANDARD_ARRIVAL_WINDOWS),
  dumpster_rental: LEGACY_TIME_WINDOWS.concat(DUMPSTER_DELIVERY_WINDOWS),
};

const MAX = {
  name: 80,
  phone: 30,
  email: 254,
  address: 200,
  city: 80,
  state: 2,
  zip: 10,
  short: 200,
  long: 2000,
};

const MAX_BODY_BYTES = 20 * 1024; // plenty for a text-only booking form; no photo bytes travel through this endpoint

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      res.status(415).json({ error: "Unsupported content type." });
      return;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: "Request body too large." });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseSecretKey) {
      console.error("Booking submission failed: SUPABASE_URL / SUPABASE_SECRET_KEY not configured");
      res.status(500).json({ error: "Booking is not available right now. Please call or text 303-990-1812." });
      return;
    }

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body) {
      res.status(400).json({ error: "Invalid request body." });
      return;
    }

    const validation = validateBooking(body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const data = validation.data;

    const supabase = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false },
    });

    let customerId;
    try {
      const { data: customerRow, error } = await supabase
        .from("customers")
        .insert({
          first_name: data.customer.firstName,
          last_name: data.customer.lastName || null,
          phone: data.customer.phone,
          email: data.customer.email || null,
          address: data.customer.streetAddress,
          city: data.customer.city,
          state: data.customer.state,
          zip: data.customer.zip,
        })
        .select("id")
        .single();

      if (error || !customerRow) {
        console.error("Booking submission failed creating customer:", error);
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
      customerId = customerRow.id;
    } catch (err) {
      console.error("Booking submission failed creating customer:", err);
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
      return;
    }

    let bookingId;
    try {
      const { data: bookingRow, error } = await supabase
        .from("bookings")
        .insert({
          customer_id: customerId,
          service_type: data.serviceType,
          appointment_date: data.appointmentDate,
          time_window: data.schedule.timeWindow,
          description: data.description,
        })
        .select("id")
        .single();

      if (error || !bookingRow) {
        console.error("Booking submission failed creating booking:", error);
        await safeDelete(supabase, "customers", customerId);
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
      bookingId = bookingRow.id;
    } catch (err) {
      console.error("Booking submission failed creating booking:", err);
      await safeDelete(supabase, "customers", customerId);
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
      return;
    }

    if (data.serviceType === "dumpster_rental") {
      try {
        const { error } = await supabase.from("dumpster_rentals").insert({
          booking_id: bookingId,
          delivery_date: data.jobDetails.deliveryDate,
          pickup_date: data.jobDetails.pickupDate,
          material_type: data.jobDetails.materialType,
          placement_notes: data.jobDetails.placementLocation,
        });

        if (error) {
          console.error("Booking submission failed creating dumpster_rentals row:", error);
          await safeDelete(supabase, "bookings", bookingId);
          await safeDelete(supabase, "customers", customerId);
          res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
          return;
        }
      } catch (err) {
        console.error("Booking submission failed creating dumpster_rentals row:", err);
        await safeDelete(supabase, "bookings", bookingId);
        await safeDelete(supabase, "customers", customerId);
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
    }

    // Best-effort admin notification — sent only after every required row for
    // this booking (customer, booking, and dumpster_rentals when applicable)
    // has been saved. Awaited so it completes before the response is sent, but
    // fully self-contained: nothing it does can change the response below.
    await sendBookingNotificationEmail(data);

    // Intentionally never returns the raw booking UUID. If photo upload is
    // configured, mint a short-lived token scoped to exactly this booking so
    // the browser can attach photos via POST /api/upload-photo without ever
    // holding a general-purpose booking identifier.
    const uploadTokenSecret = process.env.UPLOAD_TOKEN_SECRET;
    let uploadToken;
    if (uploadTokenSecret) {
      uploadToken = signUploadToken(bookingId, uploadTokenSecret);
    } else {
      console.error("Booking submission succeeded but UPLOAD_TOKEN_SECRET is not configured — photo upload will be unavailable for this booking.");
    }

    res.status(200).json(uploadToken ? { ok: true, uploadToken } : { ok: true });
  } catch (err) {
    console.error("Booking submission failed with an unexpected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    }
  }
};

async function safeDelete(supabase, table, id) {
  try {
    await supabase.from(table).delete().eq("id", id);
  } catch (err) {
    console.error("Rollback failed for " + table + " id " + id + ":", err);
  }
}

// Admin notification email via Resend, mirroring the raw-fetch pattern already
// used in api/contact.js (no @resend/node dependency in this project). Reuses
// the same RESEND_API_KEY / RESEND_FROM_EMAIL / CONTACT_TO_EMAIL env vars —
// no new sending identity or recipient variable is introduced. Every failure
// path here only logs server-side and returns normally: this function must
// never throw, since its caller awaits it in the middle of an already-
// successful booking response.
async function sendBookingNotificationEmail(data) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("Booking notification email skipped: RESEND_API_KEY is not configured.");
    return;
  }

  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || "Mile High Junk Removal <leads@milehighjunkremoval.net>";
    const toEmail = process.env.CONTACT_TO_EMAIL || "contact@milehighjunkremoval.net";
    const serviceLabel = SERVICE_LABELS[data.serviceType] || data.serviceType;
    const customerName = data.customer.firstName + " " + data.customer.lastName;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: "New Booking Request — " + serviceLabel + " — " + customerName,
        html: buildBookingNotificationHtml(data, serviceLabel, customerName),
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Booking notification email failed:", resendRes.status, errText);
    }
  } catch (err) {
    console.error("Booking notification email failed:", err && err.stack ? err.stack : err);
  }
}

// Presentation only — every value that reaches the HTML goes through
// escapeHtml() (via infoRowText/infoRow's callers below) or is a
// server-derived href built from safe parts (digits-only for tel:,
// encodeURIComponent for the Maps query string), never raw customer input
// concatenated straight into an attribute.
function buildBookingNotificationHtml(data, serviceLabel, customerName) {
  const c = data.customer;
  const j = data.jobDetails;

  const telHref = buildTelHref(c.phone);
  const phoneValueHtml = telHref
    ? '<a href="' + escapeHtml(telHref) + '" style="color:#2f6f13;text-decoration:none;">' + escapeHtml(c.phone) + "</a>"
    : escapeHtml(c.phone);

  let customerSection = sectionHeading("Customer") + infoRow("Phone", phoneValueHtml);
  if (c.email) {
    const mailtoHtml =
      '<a href="mailto:' + escapeHtml(c.email) + '" style="color:#2f6f13;text-decoration:none;">' + escapeHtml(c.email) + "</a>";
    customerSection += infoRow("Email", mailtoHtml);
  }

  const appointmentSection =
    sectionHeading("Requested Appointment") +
    infoRowText("Requested Date", formatHumanDate(data.appointmentDate)) +
    infoRowText("Requested Time / Window", TIME_WINDOW_LABELS[data.schedule.timeWindow] || data.schedule.timeWindow);

  const mapsQuery = c.streetAddress + ", " + c.city + ", " + c.state + " " + c.zip;
  const mapsHref = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(mapsQuery);
  const addressValueHtml =
    '<a href="' + escapeHtml(mapsHref) + '" style="color:#2f6f13;text-decoration:none;">' +
    escapeHtml(c.streetAddress) +
    "<br>" +
    escapeHtml(c.city + ", " + c.state + " " + c.zip) +
    "</a>";
  const addressSection = sectionHeading("Service Address") + infoRow("Address", addressValueHtml);

  // Only the fields relevant to the selected service type are included —
  // nothing blank or irrelevant to other service types.
  let detailRows = "";
  if (data.serviceType === "junk_removal") {
    detailRows += infoRowText("Items to Remove", j.itemsDescription);
    detailRows += infoRowText("Pickup Location", j.location);
    detailRows += infoRowText("Stairs", STAIRS_LABELS[j.stairs] || j.stairs);
  } else if (data.serviceType === "dumpster_rental") {
    detailRows += infoRowText("Material Type", j.materialType);
    detailRows += infoRowText("Delivery Date", formatHumanDate(j.deliveryDate));
    detailRows += infoRowText("Pickup Date", formatHumanDate(j.pickupDate));
    detailRows += infoRowText("Placement Notes", j.placementLocation);
  } else if (data.serviceType === "light_demo") {
    detailRows += infoRowText("What Needs to Be Demolished", j.demoDescription);
    detailRows += infoRowText("Approximate Size", j.approximateSize);
    detailRows += infoRowText("Debris Removal Needed", j.debrisRemovalNeeded === "yes" ? "Yes" : "No");
  }
  if (j.additionalDetails) {
    detailRows += infoRowText("Additional Details", j.additionalDetails);
  }
  const jobDetailsSection = sectionHeading("Job Details") + detailRows;

  const fontStack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3e6;">' +
    '<tr><td align="center" style="padding:28px 14px;font-family:' +
    fontStack +
    ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e8dc;">' +
    // header
    '<tr><td style="background:#141414;padding:26px 30px 22px;">' +
    '<div style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:0.12em;opacity:0.85;">MILE HIGH JUNK REMOVAL</div>' +
    '<div style="color:#8ce85a;font-size:23px;font-weight:800;letter-spacing:0.02em;margin-top:6px;">NEW BOOKING REQUEST</div>' +
    "</td></tr>" +
    // service + name banner
    '<tr><td style="background:#eaf7de;padding:18px 30px;border-bottom:1px solid #d7ecc4;">' +
    '<div style="font-size:19px;font-weight:800;color:#1c1c1c;">' +
    escapeHtml(serviceLabel) +
    " — " +
    escapeHtml(customerName) +
    "</div>" +
    "</td></tr>" +
    // customer
    '<tr><td style="padding:28px 30px 8px;">' + customerSection + "</td></tr>" +
    // appointment
    '<tr><td style="padding:14px 30px 8px;">' + appointmentSection + "</td></tr>" +
    // address
    '<tr><td style="padding:14px 30px 8px;">' + addressSection + "</td></tr>" +
    // job details
    '<tr><td style="padding:14px 30px 28px;">' + jobDetailsSection + "</td></tr>" +
    // photos footer
    '<tr><td style="background:#f6f8f2;padding:18px 30px;border-top:1px solid #ececec;">' +
    '<div style="font-size:12.5px;color:#666666;font-style:italic;line-height:1.5;">Customer may have uploaded photos with this booking. View Supabase to review booking photos.</div>' +
    "</td></tr>" +
    "</table>" +
    "</td></tr>" +
    "</table>"
  );
}

function sectionHeading(title) {
  return (
    '<div style="font-size:13px;font-weight:800;letter-spacing:0.09em;text-transform:uppercase;color:#3f7a1a;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #dff0c9;">' +
    escapeHtml(title) +
    "</div>"
  );
}

// valueHtml must already be escaped/safely constructed by the caller — this
// function does not escape it, so every call site below either passes it
// through escapeHtml() directly (infoRowText) or builds an <a> tag from
// escapeHtml()-wrapped parts only (the phone/email/address blocks above).
function infoRow(label, valueHtml) {
  return (
    '<div style="margin:0 0 18px;">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a8a8a;margin-bottom:4px;">' +
    escapeHtml(label) +
    "</div>" +
    '<div style="font-size:16px;color:#161616;font-weight:600;line-height:1.5;">' +
    valueHtml +
    "</div>" +
    "</div>"
  );
}

function infoRowText(label, value) {
  return infoRow(label, escapeHtml(String(value)).replace(/\n/g, "<br>"));
}

function formatHumanDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) return String(isoDate);
  try {
    const parsed = new Date(isoDate + "T00:00:00");
    if (Number.isNaN(parsed.getTime())) return isoDate;
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch (err) {
    return isoDate;
  }
}

// Builds a tel: href from digits only — never from the raw display string —
// so no customer-supplied character can end up inside the href attribute.
function buildTelHref(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 10 ? "tel:+1" + digits : "tel:+" + digits;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function signUploadToken(bookingId, secret) {
  const payload = JSON.stringify({ bookingId, exp: Date.now() + UPLOAD_TOKEN_TTL_MS });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return payloadB64 + "." + sig;
}

function validateBooking(body) {
  if (!SERVICE_TYPES.includes(body.serviceType)) {
    return { ok: false, error: "Please choose a valid service." };
  }
  const serviceType = body.serviceType;

  const customerIn = body.customer && typeof body.customer === "object" ? body.customer : {};
  const firstName = sanitizeText(customerIn.firstName, MAX.name);
  const lastName = sanitizeText(customerIn.lastName, MAX.name);
  const phoneRaw = sanitizeText(customerIn.phone, MAX.phone);
  const emailRaw = sanitizeText(customerIn.email, MAX.email);
  const streetAddress = sanitizeText(customerIn.streetAddress, MAX.address);
  const city = sanitizeText(customerIn.city, MAX.city);
  const state = sanitizeText(customerIn.state, MAX.state).toUpperCase();
  const zip = sanitizeText(customerIn.zip, MAX.zip);

  if (!firstName) return { ok: false, error: "First name is required." };
  if (!lastName) return { ok: false, error: "Last name is required." };
  if (!phoneRaw) return { ok: false, error: "Phone number is required." };
  if (!isValidPhone(phoneRaw)) return { ok: false, error: "Please enter a valid phone number." };
  if (emailRaw && !isValidEmail(emailRaw)) return { ok: false, error: "Please enter a valid email address." };
  if (!streetAddress) return { ok: false, error: "Street address is required." };
  if (!city) return { ok: false, error: "City is required." };
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "Please enter a valid 2-letter state." };
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, error: "Please enter a valid ZIP code." };

  const scheduleIn = body.schedule && typeof body.schedule === "object" ? body.schedule : {};
  const date = sanitizeText(scheduleIn.date, 10);
  const timeWindow = sanitizeText(scheduleIn.timeWindow, 20);

  const allowedWindows = TIME_WINDOWS_BY_SERVICE[serviceType] || [];
  if (!allowedWindows.includes(timeWindow)) {
    return { ok: false, error: "That time window isn't valid for this service. Please choose another time." };
  }

  // For dumpster_rental the delivery date collected below is the appointment date —
  // no generic preferred date is collected or required for that service type, so its
  // date + window are validated in the dumpster_rental branch below instead (against
  // deliveryDate), not here.
  if (serviceType !== "dumpster_rental") {
    if (!isValidDenverFutureDate(date)) {
      return { ok: false, error: "Please choose a valid preferred date." };
    }
    if (isTimeWindowExpired(date, timeWindow)) {
      return { ok: false, error: "That arrival window is no longer available. Please choose another time." };
    }
  }

  const jobIn = body.jobDetails && typeof body.jobDetails === "object" ? body.jobDetails : {};
  const additionalDetails = sanitizeText(jobIn.additionalDetails, MAX.long);
  let jobDetails = { additionalDetails: additionalDetails || null };
  let appointmentDate = date;

  if (serviceType === "junk_removal") {
    const itemsDescription = sanitizeText(jobIn.itemsDescription, MAX.long);
    const location = sanitizeText(jobIn.location, MAX.short);
    const stairs = sanitizeText(jobIn.stairs, 30);
    if (!itemsDescription) return { ok: false, error: "Please describe what needs to be removed." };
    if (!location) return { ok: false, error: "Please tell us where the items are located." };
    if (!STAIRS_OPTIONS.includes(stairs)) return { ok: false, error: "Please select a stairs option." };
    jobDetails = { ...jobDetails, itemsDescription, location, stairs };
  } else if (serviceType === "dumpster_rental") {
    const materialType = sanitizeText(jobIn.materialType, MAX.short);
    const deliveryDate = sanitizeText(jobIn.deliveryDate, 10);
    const pickupDate = sanitizeText(jobIn.pickupDate, 10);
    const placementLocation = sanitizeText(jobIn.placementLocation, MAX.short);
    if (!materialType) return { ok: false, error: "Please describe the type of material." };
    if (!isValidDenverFutureDate(deliveryDate)) return { ok: false, error: "Please choose a valid delivery date." };
    if (isTimeWindowExpired(deliveryDate, timeWindow)) {
      return { ok: false, error: "That delivery window is no longer available. Please choose another time." };
    }
    // Pickup date has no associated time window and isn't part of this
    // date/time feature — kept on the original (non-Denver-specific) check.
    if (!isValidFutureDate(pickupDate)) return { ok: false, error: "Please choose a valid pickup date." };
    if (new Date(pickupDate) < new Date(deliveryDate)) {
      return { ok: false, error: "Pickup date must be on or after the delivery date." };
    }
    if (!placementLocation) return { ok: false, error: "Please tell us where the dumpster should be placed." };
    jobDetails = { ...jobDetails, materialType, deliveryDate, pickupDate, placementLocation };
    // The main bookings table stays useful for scheduling: for a dumpster rental,
    // appointment_date represents the requested delivery date, not the generic
    // "preferred date" collected in the schedule step.
    appointmentDate = deliveryDate;
  } else if (serviceType === "light_demo") {
    const demoDescription = sanitizeText(jobIn.demoDescription, MAX.long);
    const approximateSize = sanitizeText(jobIn.approximateSize, MAX.short);
    const debrisRemovalNeeded = sanitizeText(jobIn.debrisRemovalNeeded, 10);
    if (!demoDescription) return { ok: false, error: "Please describe what needs to be demolished." };
    if (!approximateSize) return { ok: false, error: "Please give an approximate size." };
    if (!YES_NO.includes(debrisRemovalNeeded)) return { ok: false, error: "Please select whether debris removal is needed." };
    jobDetails = { ...jobDetails, demoDescription, approximateSize, debrisRemovalNeeded };
  }

  return {
    ok: true,
    data: {
      serviceType,
      jobDetails,
      description: buildDescription(serviceType, jobDetails),
      appointmentDate,
      schedule: { date, timeWindow },
      customer: {
        firstName,
        lastName,
        phone: phoneRaw,
        email: emailRaw || null,
        streetAddress,
        city,
        state,
        zip,
      },
    },
  };
}

function buildDescription(serviceType, jobDetails) {
  const lines = [];
  if (serviceType === "junk_removal") {
    lines.push("Items to remove: " + jobDetails.itemsDescription);
    lines.push("Location: " + jobDetails.location);
    lines.push("Stairs: " + (STAIRS_LABELS[jobDetails.stairs] || jobDetails.stairs));
  } else if (serviceType === "dumpster_rental") {
    lines.push("Material type: " + jobDetails.materialType);
    lines.push("Delivery date: " + jobDetails.deliveryDate);
    lines.push("Pickup date: " + jobDetails.pickupDate);
    lines.push("Placement: " + jobDetails.placementLocation);
  } else if (serviceType === "light_demo") {
    lines.push("What needs to be demolished: " + jobDetails.demoDescription);
    lines.push("Approximate size: " + jobDetails.approximateSize);
    lines.push("Debris removal needed: " + (jobDetails.debrisRemovalNeeded === "yes" ? "Yes" : "No"));
  }
  if (jobDetails.additionalDetails) {
    lines.push("Additional details: " + jobDetails.additionalDetails);
  }
  return lines.join("\n");
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLen);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX.email;
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^[0-9+()\-.\s]+$/.test(value);
}

function isValidFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00");
  if (Number.isNaN(parsed.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed.getTime() >= today.getTime();
}

// Current America/Denver local time as {year, month (1–12), day, hour,
// minute} — deliberately never the server process's own local time (UTC on
// Vercel), so "today" and window-expiration checks match what the customer
// actually saw in the browser regardless of where this function runs. The
// IANA timeZone database entry for America/Denver resolves MST/MDT (DST)
// automatically, so no manual DST math is needed here. Mirrors the
// client-side getDenverNow() in book/book.js.
function getDenverNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some engines report midnight as "24" with hour12:false
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: hour,
    minute: parseInt(parts.minute, 10),
  };
}
function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}
function denverTodayIso() {
  const now = getDenverNow();
  return now.year + "-" + pad2(now.month) + "-" + pad2(now.day);
}

// Denver-timezone counterpart to isValidFutureDate() above, used for the
// schedule date (junk removal / light demo) and the dumpster delivery date —
// both of which pair with a time window and so must use the same "today" as
// the expiration check below. Zero-padded ISO (YYYY-MM-DD) strings compare
// correctly with a plain string comparison for "is it today or later", so no
// Date-object month/year rollover arithmetic is needed for that part. The
// Date.UTC() round-trip below only checks that the value is a real calendar
// date (rejects e.g. month 13 or day 40, which JS silently normalizes rather
// than erroring on) — UTC is used purely for that check, so it carries no
// timezone/DST ambiguity of its own.
function isValidDenverFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== d) return false;
  return value >= denverTodayIso();
}

// True only when `date` (already known to be today-or-later in Denver terms
// via isValidDenverFutureDate) is today in America/Denver AND the given
// window's start time has already passed. Future dates are never expired. An
// unrecognized window on today's date is treated as expired/unavailable
// rather than silently accepted — TIME_WINDOWS_BY_SERVICE is what actually
// enforces "is this a recognized/allowed window" and runs before this check.
function isTimeWindowExpired(date, timeWindowId) {
  if (date !== denverTodayIso()) return false;
  const def = TIME_WINDOW_DEFS[timeWindowId];
  if (!def) return true;
  const now = getDenverNow();
  const nowDecimalHour = now.hour + now.minute / 60;
  return def.startHour <= nowDecimalHour;
}
