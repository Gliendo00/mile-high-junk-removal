// Site Improvement Agent — the ONE whitelisted auto-apply fixer in Phase 1.
//
// Rewrites a single <a href="..."> occurrence in one file, from an exact
// literal string to another exact literal string. That's it — no regex
// substitution of partial matches, no touching anything else on the page,
// no content/copy changes. Used only for the two mechanical link findings
// (redirect-hop-internal-link, broken-internal-link-fixable) whose `to`
// value was itself derived from on-disk facts (vercel.json redirects or an
// exact case-insensitive filename match), never guessed.
//
// Refuses (returns {changed: false, reason}) rather than guessing whenever
// the match isn't exactly singular, so a run can never silently touch the
// wrong occurrence.

const fs = require("fs");
const path = require("path");
const config = require("../../config");

function apply(autoFix) {
  const fullPath = path.join(config.SITE_ROOT, autoFix.file);
  const original = fs.readFileSync(fullPath, "utf8");

  const needle = `href="${autoFix.from}"`;
  const needleSingle = `href='${autoFix.from}'`;
  const countDouble = original.split(needle).length - 1;
  const countSingle = original.split(needleSingle).length - 1;
  const totalCount = countDouble + countSingle;

  if (totalCount === 0) {
    return { changed: false, reason: `href="${autoFix.from}" not found in ${autoFix.file} (file may have changed since scan)` };
  }
  if (totalCount > 1) {
    return { changed: false, reason: `href="${autoFix.from}" appears ${totalCount} times in ${autoFix.file} — refusing to guess which to rewrite` };
  }

  const replacement = countDouble === 1 ? `href="${autoFix.to}"` : `href='${autoFix.to}'`;
  const matchNeedle = countDouble === 1 ? needle : needleSingle;
  const updated = original.replace(matchNeedle, replacement);

  fs.writeFileSync(fullPath, updated, "utf8");

  return {
    changed: true,
    file: autoFix.file,
    before: autoFix.from,
    after: autoFix.to,
  };
}

module.exports = { apply };
