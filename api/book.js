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
const TIME_WINDOWS = ["morning", "midday", "afternoon", "evening"];
const TIME_WINDOW_LABELS = {
  morning: "Morning (8am–11am)",
  midday: "Midday (11am–2pm)",
  afternoon: "Afternoon (2pm–5pm)",
  evening: "Evening (5pm–7pm)",
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

function buildBookingNotificationHtml(data, serviceLabel, customerName) {
  const c = data.customer;
  const j = data.jobDetails;

  const topRows = [
    ["Service", serviceLabel],
    ["Customer", customerName],
    ["Phone", c.phone],
    ["Email", c.email || "—"],
    ["Requested Date", data.appointmentDate],
    ["Requested Time / Time Window", TIME_WINDOW_LABELS[data.schedule.timeWindow] || data.schedule.timeWindow],
    ["Service Address", c.streetAddress],
    ["City", c.city],
    ["State", c.state],
    ["ZIP", c.zip],
  ];

  // Only the fields relevant to the selected service type are included —
  // nothing blank or irrelevant to other service types.
  const detailRows = [];
  if (data.serviceType === "junk_removal") {
    detailRows.push(["Items to Remove", j.itemsDescription]);
    detailRows.push(["Pickup Location", j.location]);
    detailRows.push(["Stairs", STAIRS_LABELS[j.stairs] || j.stairs]);
  } else if (data.serviceType === "dumpster_rental") {
    detailRows.push(["Material Type", j.materialType]);
    detailRows.push(["Delivery Date", j.deliveryDate]);
    detailRows.push(["Pickup Date", j.pickupDate]);
    detailRows.push(["Placement Notes", j.placementLocation]);
  } else if (data.serviceType === "light_demo") {
    detailRows.push(["What Needs to Be Demolished", j.demoDescription]);
    detailRows.push(["Approximate Size", j.approximateSize]);
    detailRows.push(["Debris Removal Needed", j.debrisRemovalNeeded === "yes" ? "Yes" : "No"]);
  }
  if (j.additionalDetails) {
    detailRows.push(["Additional Details", j.additionalDetails]);
  }

  return (
    "<p style=\"font-size:18px;font-weight:bold;margin:0 0 12px\">NEW BOOKING REQUEST</p>" +
    renderRows(topRows) +
    "<hr style=\"border:none;border-top:1px solid #ddd;margin:16px 0\">" +
    renderRows(detailRows) +
    "<p style=\"margin-top:20px\"><em>Customer may have uploaded photos with this booking. View Supabase to review booking photos.</em></p>"
  );
}

function renderRows(rows) {
  return rows
    .map(function (pair) {
      return (
        "<p style=\"margin:0 0 8px\"><strong>" +
        escapeHtml(pair[0]) +
        ":</strong><br>" +
        escapeHtml(String(pair[1])).replace(/\n/g, "<br>") +
        "</p>"
      );
    })
    .join("");
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
  // For dumpster_rental the delivery date collected below is the appointment date —
  // no generic preferred date is collected or required for that service type.
  if (serviceType !== "dumpster_rental" && !isValidFutureDate(date)) {
    return { ok: false, error: "Please choose a valid preferred date." };
  }
  if (!TIME_WINDOWS.includes(timeWindow)) return { ok: false, error: "Please choose a valid time window." };

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
    if (!isValidFutureDate(deliveryDate)) return { ok: false, error: "Please choose a valid delivery date." };
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
