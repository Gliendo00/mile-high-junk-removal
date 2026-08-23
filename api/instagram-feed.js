// Vercel serverless function — fetches the newest Instagram posts server-side
// so the access token never reaches the browser.
//
// Deliberately uses "Instagram API with Facebook Login" (graph.facebook.com),
// not the newer "Instagram API with Instagram Login" (graph.instagram.com).
// Per Meta's current IG Media field reference, `caption` is documented as
// "Available for Instagram API with Facebook Login only" — the Instagram
// Login flavor cannot return captions at all — and this feed shows a short
// caption preview on each card, so Facebook Login is the only option that
// supports what this UI needs. That means the Instagram professional account
// must stay linked to a Facebook Page (already true for this business).
//
// Configure IG_ACCESS_TOKEN and IG_BUSINESS_ACCOUNT_ID as environment
// variables in Vercel. IG_BUSINESS_ACCOUNT_ID is the Instagram Business
// Account ID exposed on the linked Facebook Page (GET /{page-id}?fields=
// instagram_business_account). IG_ACCESS_TOKEN needs the `instagram_basic`
// and `pages_show_list` (or `pages_read_engagement`) permissions — a Meta
// System User access token (Business Manager > System Users) is recommended
// over a regular long-lived user/page token for this read-only server job,
// since it can be issued to never expire, avoiding a recurring manual
// renewal step. This is a single business reading only its own account's
// media, so it only needs Standard Access — no Meta App Review or Business
// Verification is required.
var POST_LIMIT = 6;

// Only persists for the lifetime of a warm serverless instance — not a
// durable cache, and it resets on cold start or redeploy. The real caching
// layer is the Cache-Control header below, which lets Vercel's CDN serve
// this response for hours without re-hitting Meta; this in-memory copy is
// just a best-effort extra fallback if a request happens to land on a warm
// instance right after a transient Meta API failure.
var lastGood = null;

module.exports = async (req, res) => {
  var token = process.env.IG_ACCESS_TOKEN;
  var igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;

  if (!token || !igUserId) {
    res.status(200).json({ posts: [], available: false });
    return;
  }

  try {
    var fields = "id,media_type,media_product_type,media_url,thumbnail_url,permalink,caption,timestamp";
    var url =
      "https://graph.facebook.com/v25.0/" + encodeURIComponent(igUserId) +
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
        // media_type is only ever CAROUSEL_ALBUM, IMAGE, or VIDEO — Reels are
        // VIDEO media with media_product_type "REELS", not a separate
        // media_type value. isVideo drives which URL/play-icon to use;
        // isReel is just for the "Reel" label so a plain feed video isn't
        // mislabeled.
        var isVideo = p.media_type === "VIDEO";
        return {
          id: p.id,
          isVideo: isVideo,
          isReel: p.media_product_type === "REELS",
          image: isVideo ? (p.thumbnail_url || p.media_url) : p.media_url,
          permalink: p.permalink,
          caption: truncateCaption(p.caption),
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

function truncateCaption(caption) {
  if (!caption) return "";
  var firstLine = caption.split("\n")[0].trim();
  return firstLine.length > 90 ? firstLine.slice(0, 87).trim() + "…" : firstLine;
}
