// Vercel serverless function — fetches live Google reviews server-side so the
// API key never reaches the browser. Configure GOOGLE_PLACES_API_KEY and
// GOOGLE_PLACE_ID as environment variables in the Vercel project settings.
//
// Uses Places API (New) Place Details (places.googleapis.com/v1). The legacy
// Places API's place_id namespace doesn't reliably resolve IDs minted by the
// New API's Text Search — which is how GOOGLE_PLACE_ID was obtained here —
// so Place Details must be queried through the same New API family.
module.exports = async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    res.status(500).json({ error: "Reviews are not configured yet." });
    return;
  }

  try {
    const url = "https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId);

    const googleRes = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,reviews",
      },
    });
    const data = await googleRes.json();

    if (!googleRes.ok) {
      // Full detail goes to server-side logs only — the client only ever
      // sees a generic status string, never the raw Google error body.
      console.error("Places API (New) request failed:", googleRes.status, JSON.stringify(data));
      res.status(502).json({ error: "Google API error", status: (data.error && data.error.status) || "UNKNOWN" });
      return;
    }

    const reviews = (data.reviews || []).map((r) => ({
      author: r.authorAttribution && r.authorAttribution.displayName,
      rating: r.rating,
      text: r.text && r.text.text,
      relativeTime: r.relativePublishTimeDescription,
      time: r.publishTime ? Math.floor(new Date(r.publishTime).getTime() / 1000) : undefined,
    }));

    // Cache at the edge for an hour so we don't hit Google on every page view;
    // serves slightly-stale data for up to a day while refreshing in the background.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      rating: data.rating,
      totalReviews: data.userRatingCount,
      reviews,
    });
  } catch (err) {
    console.error("Failed to fetch reviews:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Failed to fetch reviews." });
  }
};
