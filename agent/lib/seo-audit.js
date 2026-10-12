// Site Improvement Agent — on-page SEO/metadata audit.
//
// Pure, read-only: reasons only about facts already present in the
// scanner's PageRecords (title/description length, duplicates, canonical
// correctness, presence of schema/H1). Never proposes or writes new copy —
// writing title/description text is a content decision this module
// deliberately leaves to a human or a future research-backed step.

const config = require("../config");
const { makeFinding } = require("./findings");
const { buildRewriteCleanUrlMap } = require("./link-audit");

function auditSeo(pages) {
  const findings = [];
  const titleOwners = new Map(); // title -> [files]
  const descOwners = new Map();
  const cleanUrlMap = buildRewriteCleanUrlMap();

  for (const page of pages) {
    if (!page.title) {
      findings.push(
        makeFinding({
          type: "missing-title",
          summary: `${page.file} has no <title> tag.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "title", value: null }],
          recommendation: `Add a descriptive <title> to ${page.file}.`,
        })
      );
    } else {
      if (page.title.length < config.TITLE_MIN || page.title.length > config.TITLE_MAX) {
        findings.push(
          makeFinding({
            type: "title-length",
            summary: `${page.file}'s title is ${page.title.length} characters (recommended ${config.TITLE_MIN}-${config.TITLE_MAX}).`,
            pages: [page.file],
            evidence: [{ file: page.file, field: "title", value: page.title }],
            recommendation: `Review the title length on ${page.file} for search-result truncation.`,
          })
        );
      }
      const owners = titleOwners.get(page.title) || [];
      owners.push(page.file);
      titleOwners.set(page.title, owners);
    }

    if (!page.metaDescription) {
      findings.push(
        makeFinding({
          type: "missing-meta-description",
          summary: `${page.file} has no meta description.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "metaDescription", value: null }],
          recommendation: `Add a meta description to ${page.file}.`,
        })
      );
    } else {
      if (
        page.metaDescription.length < config.DESCRIPTION_MIN ||
        page.metaDescription.length > config.DESCRIPTION_MAX
      ) {
        findings.push(
          makeFinding({
            type: "description-length",
            summary: `${page.file}'s meta description is ${page.metaDescription.length} characters (recommended ${config.DESCRIPTION_MIN}-${config.DESCRIPTION_MAX}).`,
            pages: [page.file],
            evidence: [{ file: page.file, field: "metaDescription", value: page.metaDescription }],
            recommendation: `Review the meta description length on ${page.file} for search-result truncation.`,
          })
        );
      }
      const owners = descOwners.get(page.metaDescription) || [];
      owners.push(page.file);
      descOwners.set(page.metaDescription, owners);
    }

    if (!page.canonical) {
      findings.push(
        makeFinding({
          type: "missing-canonical",
          summary: `${page.file} has no canonical link tag.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "canonical", value: null }],
          recommendation: `Add a self-referencing canonical tag to ${page.file}.`,
        })
      );
    } else {
      // A page served under a clean URL via an invisible vercel.json
      // rewrite (e.g. privacy-policy.html -> /privacy-policy) is correctly
      // canonicalized to that clean URL, not its own .html filename — the
      // opposite of every other page on the site, so check that alias
      // before treating a difference as a mismatch.
      const cleanUrl = cleanUrlMap.get(page.file);
      const expectedUrl = cleanUrl ? config.SITE_ORIGIN + "/" + cleanUrl : page.url;
      if (page.canonical.replace(/\/$/, "") !== expectedUrl.replace(/\/$/, "")) {
        findings.push(
          makeFinding({
            type: "canonical-mismatch",
            summary: `${page.file}'s canonical tag (${page.canonical}) does not match its expected URL (${expectedUrl}).`,
            pages: [page.file],
            evidence: [
              { file: page.file, field: "canonical", value: page.canonical },
              { file: page.file, field: "expectedUrl", value: expectedUrl },
            ],
            recommendation: `Confirm whether this mismatch is intentional; if not, correct the canonical tag.`,
          })
        );
      }
    }

    if (page.h1s.length === 0) {
      findings.push(
        makeFinding({
          type: "missing-h1",
          summary: `${page.file} has no <h1> element.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "h1s", value: [] }],
          recommendation: `Add a single descriptive <h1> to ${page.file}.`,
        })
      );
    } else if (page.h1s.length > 1) {
      findings.push(
        makeFinding({
          type: "multiple-h1",
          summary: `${page.file} has ${page.h1s.length} <h1> elements.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "h1s", value: page.h1s }],
          recommendation: `Reduce ${page.file} to a single <h1>; demote the others to <h2>/<h3>.`,
        })
      );
    }

    const validJsonLd = page.jsonLd.filter((b) => !b.__parseError);
    if (validJsonLd.length === 0) {
      findings.push(
        makeFinding({
          type: "missing-json-ld",
          summary: `${page.file} has no valid JSON-LD structured data.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "jsonLd", value: page.jsonLd }],
          recommendation: `Add structured data to ${page.file}, consistent with comparable pages on the site.`,
        })
      );
    }
  }

  for (const [title, files] of titleOwners) {
    if (files.length > 1) {
      findings.push(
        makeFinding({
          type: "duplicate-title",
          summary: `${files.length} pages share the exact same <title>: "${title}".`,
          pages: files,
          evidence: [{ field: "title", value: title, pages: files }],
          recommendation: `Review ${files.join(", ")} for keyword cannibalization; give each page a distinct, specific title.`,
        })
      );
    }
  }

  for (const [desc, files] of descOwners) {
    if (files.length > 1) {
      findings.push(
        makeFinding({
          type: "duplicate-meta-description",
          summary: `${files.length} pages share the exact same meta description.`,
          pages: files,
          evidence: [{ field: "metaDescription", value: desc, pages: files }],
          recommendation: `Review ${files.join(", ")} and write distinct descriptions for each.`,
        })
      );
    }
  }

  return findings;
}

module.exports = { auditSeo };
