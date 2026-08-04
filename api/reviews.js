// Vercel serverless function — fetches live Google reviews server-side so the
// API key never reaches the browser. Configure GOOGLE_PLACES_API_KEY and
// GOOGLE_PLACE_ID as environment variables in the Vercel project settings.
module.exports = async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    res.status(500).json({ error: "Reviews are not configured yet." });
    return;
  }

  try {
    const url =
      "https://maps.googleapis.com/maps/api/place/details/json" +
      "?place_id=" + encodeURIComponent(placeId) +
      "&fields=rating,user_ratings_total,reviews" +
      "&reviews_sort=newest" +
      "&key=" + encodeURIComponent(apiKey);

    const googleRes = await fetch(url);
    const data = await googleRes.json();

    if (data.status !== "OK") {
      res.status(502).json({ error: "Google API error", status: data.status });
      return;
    }

    const result = data.result || {};
    const reviews = (result.reviews || []).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      relativeTime: r.relative_time_description,
      time: r.time,
    }));

    // Cache at the edge for an hour so we don't hit Google on every page view;
    // serves slightly-stale data for up to a day while refreshing in the background.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      rating: result.rating,
      totalReviews: result.user_ratings_total,
      reviews,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch reviews." });
  }
};
