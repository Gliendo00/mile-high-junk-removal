# Mile High Junk Removal Website + CRM

## Repository scope

This repository contains the production website and internal CRM for Mile High Junk Removal.

The application is primarily:
- static HTML
- CSS
- vanilla JavaScript
- Vercel serverless API routes
- Node-based regression tests

The public website and admin CRM share some global styling, so visual changes must be scoped carefully.

## Primary goal

Prioritize:
- clean mobile UX
- simple interfaces
- fast load times
- strong visual hierarchy
- consistent spacing and typography
- preserving all existing business logic
- preserving SEO, tracking, forms, payments, and CRM behavior

## Visual-only tasks

When a task is described as visual, styling, layout, UX, image, responsive, spacing, typography, or appearance-related:

You may modify:
- HTML structure when required for layout
- CSS
- presentational frontend JavaScript
- image references
- responsive styles
- spacing
- typography
- buttons
- cards
- visual states
- non-functional UI organization

Do not change business logic unless explicitly instructed.

## Protected areas

Do not modify these during visual-only work:

- authentication
- session handling
- database access
- SQL migrations
- Supabase logic
- Stripe integration
- payment logic
- invoices
- payment ledgers
- pricing calculations
- booking calculations
- revenue calculations
- webhooks
- form submission logic
- uploads
- notifications
- customer/client data handling
- analytics or conversion tracking
- phone/SMS tracking
- canonical URLs
- structured data
- JSON-LD
- sitemap
- robots.txt
- redirects
- Vercel configuration
- environment files
- automation workflows
- website-agent execution logic

Do not change `nav.js` analytics or phone/SMS tracking during visual work.

## DOM safety

Do not rename or remove:
- DOM IDs
- form field names
- data attributes
- classes used as JavaScript selectors
- selectors consumed by existing scripts

If a visual redesign would require changing one of these, preserve compatibility or explain the conflict before changing it.

## CSS safety

`styles.css` is shared by the public website and admin CRM.

Before modifying global CSS:
- determine what pages/selectors are affected
- prefer scoped selectors when possible
- avoid broad rules that can unintentionally change admin pages
- avoid broad admin rules that can affect public pages

Admin-specific visual work should prefer:
- `admin/admin.css`
- page-specific admin markup/styles

Booking-specific work should prefer:
- `book/book.css`

Invoice-specific work should prefer:
- `invoice/invoice.css`

## Images

Production images live in `images/`.

When adding or replacing images:
- preserve meaningful alt text
- use descriptive filenames
- avoid oversized assets
- preserve aspect ratio unless redesign requires otherwise
- avoid layout shift
- use responsive image techniques where useful
- reuse existing project conventions
- do not replace production images unrelated to the task

## Mobile-first requirements

Every visual change must be reviewed for:
- desktop
- tablet
- mobile

The CRM is frequently used on mobile.

For CRM work, prioritize:
- compact vertical spacing
- easy tap targets
- readable typography
- avoiding horizontal overflow
- quick access to core actions
- preserving information density without clutter

## Existing project guidance

Read `CLAUDE.md` before making meaningful changes.

Also review relevant documentation in `docs/` when the task touches:
- architecture
- security
- requirements
- test coverage

If `CLAUDE.md` and this file differ, follow the stricter safety rule.

## Git workflow

Do not make meaningful feature or visual changes directly on `main`.

For changes:
1. confirm the working tree is clean
2. create a dedicated feature branch
3. make the smallest reasonable change
4. review the diff
5. run relevant checks
6. summarize all changed files
7. stop before merge/push/deployment unless explicitly authorized

Do not push, merge, or deploy without explicit authorization.

## Testing

There is no general build pipeline.

Use the relevant Node regression suites where applicable.

Examples:
- `node tests/<relevant-test>.test.js`

For visual-only changes:
- run syntax checks for modified JavaScript
- review HTML/CSS changes for regressions
- run relevant existing tests if shared behavior is touched

Do not claim something was visually verified unless it was actually previewed or inspected.

## Preview

Static pages can be previewed from the workspace root using:

`npx serve site`

Static preview does not exercise Vercel serverless API routes.

Do not assume backend behavior was validated from static preview alone.

## Production safety

Production deployment requires explicit authorization.

Do not:
- push to production
- merge to main
- deploy
- alter production environment variables

unless explicitly instructed.

## Completion format

At the end of a task, report:
- branch name
- files changed
- visual changes made
- whether business logic changed
- tests/checks run
- anything not verified
- whether anything was pushed or deployed
