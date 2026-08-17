# Mile High Junk Removal — Production Repository

This repository powers the production website for `milehighjunkremoval.net`.
Production safety is the highest priority.

## Production Safety

* NEVER push to GitHub unless Rocky explicitly authorizes the push.
* NEVER deploy to production unless Rocky explicitly authorizes deployment.
* A request to build, edit, fix, optimize, research, audit, or implement something is NOT permission to push or deploy.
* Never modify DNS, domain configuration, Vercel production settings, environment variables, analytics, tracking, forms, booking integrations, or production infrastructure unless Rocky explicitly authorizes it.
* Never delete or rename an existing production URL without explicit approval.
* Never force push or rewrite production Git history.
* Never make unrelated changes.
* If authorization for a production-impacting action is unclear, STOP and ask Rocky.

## Required Workflow

Before modifying the website:

1. Inspect the existing implementation.
2. Run `git status`.
3. Confirm the current branch.
4. Understand the existing implementation before changing it.
5. Make the smallest safe change necessary.
6. Preserve existing functionality and SEO.
7. Test the change.
8. Check for errors, broken links, layout problems, mobile problems, and unintended changes.
9. Report exactly which files changed.
10. Report test results.
11. STOP before pushing or deploying unless Rocky explicitly authorized it.

For substantial work, confirm or create a safe Git checkpoint first.

## Git Safety

* Treat `main` as production-sensitive.
* Prefer separate development branches for major features, experiments, and programmatic SEO.
* Never force push.
* Never rewrite production history.
* Never automatically push after completing work.
* Never combine unrelated changes in the same commit.
* Before any push, state exactly which commit or commits will be pushed.
* If Rocky has not explicitly authorized the push, STOP.

## SEO Safety

Organic search and local SEO are business-critical.

* Preserve existing URLs whenever possible.
* Check for keyword cannibalization before creating overlapping pages.
* Preserve or intentionally improve internal linking.
* Maintain correct canonical tags.
* Maintain valid structured data/schema.
* Maintain sitemap integrity.
* Avoid duplicate content.
* Avoid doorway pages.
* Avoid thin location pages.
* Do not mass-publish AI-generated pages.
* Programmatic SEO must initially be developed and tested separately from production.
* Validate a small group of high-quality programmatic pages before considering larger-scale publishing.

## Business Accuracy

Never invent business information, including:

* Reviews
* Testimonials
* Customer names
* Jobs performed
* Locations where jobs were performed
* Pricing
* Licenses
* Certifications
* Awards
* Partnerships
* Business statistics

Ask Rocky when required information is unknown.

## Scope

This repository is exclusively for Mile High Junk Removal and `milehighjunkremoval.net`.

Do not mix this repository with:

* Website-builder/template development
* Other businesses
* Customer websites
* Unrelated experiments

## Decision Priority

Prioritize:

1. Production safety
2. Leads and conversions
3. Existing SEO rankings and indexed URLs
4. Technical correctness
5. Local search visibility
6. User experience
7. Performance
8. New functionality

When uncertain, inspect first and change less.
