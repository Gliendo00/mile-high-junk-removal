// Vercel serverless function — creates a customer + booking (+ dumpster_rentals
// row when applicable) in Supabase from the /book/ multi-step form.
//
// Required environment variables (server-side only, never read by the browser):
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//
// Column names below match the live schema exactly:
//   customers(id, first_name, last_name, phone, email, address, city, state, zip, created_at)
//   bookings(id, customer_id, service_type, appointment_date, time_window, status,
//            description, estimated_price, final_price, internal_notes, created_at, updated_at)
//   dumpster_rentals(id, booking_id UNIQUE, delivery_date, pickup_date, material_type,
//                     placement_notes, created_at)
//   booking_photos — not written to yet; Supabase Storage isn't configured.

const { createClient } = require("@supabase/supabase-js");

const SERVICE_TYPES = ["junk_removal", "dumpster_rental", "light_demo"];
const STAIRS_OPTIONS = ["none", "some", "multiple_flights"];
const STAIRS_LABELS = { none: "No stairs", some: "Some stairs", multiple_flights: "Multiple flights" };
const YES_NO = ["yes", "no"];
const TIME_WINDOWS = ["morning", "midday", "afternoon", "evening"];

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

    // Intentionally does not return the booking UUID — the browser doesn't need it yet.
    res.status(200).json({ ok: true });
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
  if (!isValidFutureDate(date)) return { ok: false, error: "Please choose a valid appointment date." };
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
