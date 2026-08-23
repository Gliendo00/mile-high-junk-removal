// Vercel serverless function — fetches the newest Instagram posts server-side
// so the access token never reaches the browser.
//
// Uses "Instagram API with Instagram Login" (graph.instagram.com) — the
// account (milehigh_junkremoval, IG user id 17841477969534048) is connected
// through Business Login for Instagram directly, not via a linked Facebook
// Page, so this does NOT use the graph.facebook.com Page-discovery flow.
//
// Trade-off vs. the Facebook Login flavor: per Meta's current IG Media field
// reference, both `caption` and `media_product_type` are documented as
// "Available for Instagram API with Facebook Login only" — Instagram Login
// cannot return either one. That means this endpoint can't return a caption
// preview, and can't tell a Reel apart from a plain feed video (both are
// just media_type "VIDEO"). The response below always sends caption: "" and
// isReel: false for that reason — the frontend already renders correctly
// with no caption and no "Reel" label, so no UI changes were needed.
//
// Configure these two environment variables in Vercel:
//   INSTAGRAM_ACCESS_TOKEN — long-lived Instagram User access token for the
//     milehigh_junkremoval account, obtained via Business Login for
//     Instagram with the `instagram_business_basic` scope (the only scope
//     this read-only feed needs). Long-lived tokens last 60 days and must
//     be refreshed via graph.instagram.com/refresh_access_token before they
//     expire (refresh window: at least 24h old, not yet expired).
//   INSTAGRAM_USER_ID — the Instagram-scoped user ID for the account
//     (17841477969534048). Not a secret, but kept as an env var rather than
//     hardcoded so this file has no account-specific literals.
var POST_LIMIT = 6;

// Only persists for the lifetime of a warm serverless instance — not a
// durable cache, and it resets on cold start or redeploy. The real caching
// layer is the Cache-Control header below, which lets Vercel's CDN serve
// this response for hours without re-hitting Meta; this in-memory copy is
// just a best-effort extra fallback if a request happens to land on a warm
// instance right after a transient Meta API failure.
var lastGood = null;

module.exports = async (req, res) => {
  var token = process.env.INSTAGRAM_ACCESS_TOKEN;
  var igUserId = process.env.INSTAGRAM_USER_ID;

  if (!token || !igUserId) {
    res.status(200).json({ posts: [], available: false });
    return;
  }

  try {
    // caption and media_product_type are deliberately omitted — both require
    // Instagram API with Facebook Login and would otherwise just come back
    // empty; requesting only what this flavor actually supports keeps the
    // request (and any Meta-side field errors) honest.
    var fields = "id,media_type,media_url,thumbnail_url,permalink,timestamp";
    var url =
      "https://graph.instagram.com/v25.0/" + encodeURIComponent(igUserId) +
      "/media?fields=" + fields + "&limit=" + POST_LIMIT +
      "&access_token=" + encodeURIComponent(token);

    var igRes = await fetch(url);
    var data = await igRes.json();

    if (!igRes.ok) {
      // Full detail goes to server-side logs only — visitors never see the
      // raw Meta error body, status code, or token.
      console.error("Instagram API request failed:", igRes.status, JSON.stringify(data));
      if (lastGood) {
        res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=86400");
        res.status(200).json(lastGood);
        return;
      }
      res.status(200).json({ posts: [], available: false });
      return;
    }

    var seen = {};
    var posts = (data.data || [])
      .filter(function (p) { return p && p.id && !seen[p.id] && (seen[p.id] = true); })
      .slice(0, POST_LIMIT)
      .map(function (p) {
        // media_type is only ever CAROUSEL_ALBUM, IMAGE, or VIDEO. Video vs.
        // Reel can't be distinguished under Instagram Login (that's
        // media_product_type, which this flavor doesn't return), so every
        // video is just treated as a video — isReel stays false rather than
        // guessing.
        var isVideo = p.media_type === "VIDEO";
        return {
          id: p.id,
          isVideo: isVideo,
          isReel: false,
          image: isVideo ? (p.thumbnail_url || p.media_url) : p.media_url,
          permalink: p.permalink,
          caption: "",
          timestamp: p.timestamp,
        };
      })
      .filter(function (p) { return p.image && p.permalink; });

    var payload = { posts: posts, available: true };
    lastGood = payload;

    // Cache at Vercel's edge for a few hours so the homepage never calls Meta
    // directly on page load; refreshes in the background after that window
    // while still serving instantly from cache in the meantime.
    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");
    res.status(200).json(payload);
  } catch (err) {
    console.error("Failed to fetch Instagram feed:", err && err.stack ? err.stack : err);
    if (lastGood) {
      res.status(200).json(lastGood);
      return;
    }
    res.status(200).json({ posts: [], available: false });
  }
};
