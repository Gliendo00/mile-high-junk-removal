# Vercel Hobby Plan — 12 Serverless Function Limit (Preview Deployment Finding)

Status: **confirmed via a real failed deployment during Phase 3C Stage 1
Preview verification, then fixed on the feature branch.** Not a
hypothetical — this is exactly what happened.

## What happened

The Vercel project for this site (`mile-high-junk-removal`, team
`gliendo00-4614s-projects`) is on the **Hobby plan**, which caps a single
deployment at **12 Serverless Functions**. Before Phase 3C Stage 1, this
project had exactly 12 function-producing files under `api/` (5 direct:
`book.js`, `contact.js`, `instagram-feed.js`, `reviews.js`,
`upload-photo.js`; 7 under `api/admin/`: `booking-status.js`, `booking.js`,
`bookings.js`, `client.js`, `clients.js`, `login.js`, `logout.js`) — already
sitting exactly at the ceiling.

Stage 1 added two new files, `api/admin/schedule.js` and
`api/admin/new-count.js`, bringing the total to 14. The first Preview
deployment for commit `457c54f` failed as a result:

```
Build Completed in /vercel/output [4s]
Deploying outputs...
Error: No more than 12 Serverless Functions can be added to a Deployment
on the Hobby plan. Create a team (Pro plan) to deploy more.
```

The build itself succeeds (bundling/compiling every function works fine);
the failure happens at the deploy step, when Vercel tries to register the
functions against the plan's limit. This is why the GitHub commit status
showed a generic "Deployment has failed" with no further detail — the
useful error only surfaces via `vercel inspect --logs` or a direct
`vercel deploy` attempt, not in the GitHub check itself.

Files under `api/_lib/` do **not** count toward this limit — confirmed by
inspecting the local `vercel build` output (`.vercel/output/functions/`):
only files that actually export a `(req, res)` handler become their own
`.func` output. This project's five pre-existing `_lib` helper files (now
six, with `time-windows.js`) have never been the issue.

## Fix applied on the feature branch

Rather than keeping `api/admin/new-count.js` as its own file, the Requests
badge count was folded into `api/admin/bookings.js` as an optional
`?countsOnly=1` query mode: `bookings.js` already computes the exact same
six-way status summary on every call it serves, so returning just that
summary (skipping the more expensive booking-row/customer/photo-count work)
needed no new function. `api/admin/schedule.js` stayed its own dedicated
file. Net new functions for Stage 1: **zero** — the total is back to exactly
12, and the second Preview deployment (see the chat report for the SHA)
succeeded.

A new test
([tests/phase3c-schedule.test.js](../../tests/phase3c-schedule.test.js))
counts function-producing files under `api/` and fails if the total exceeds
12, so a future stage that naively adds another standalone endpoint file
fails locally and loudly instead of only failing at deploy time again.

## Implication for the rest of the Phase 3C plan

This ceiling is real and will be hit again. The remaining Phase 3C stages
each want at least one new write endpoint of their own — Create Job, Create
Client, payment/tip/notes editing, archive/delete (client and job each) —
which is 5+ more candidate files against a budget that is already full.
Two paths forward, to decide before those stages are built rather than
during another failed Preview deploy:

1. **Keep consolidating**, the way this fix did — group related operations
   into fewer files using a query param or `req.method` to distinguish
   actions (e.g. a single `api/admin/job.js` handling create, and folding
   status/price/notes edits into the existing detail-adjacent files). This
   costs nothing but adds internal branching to files that would otherwise
   stay single-purpose.
2. **Upgrade the Vercel project to a paid (Pro) plan**, which removes the
   12-function ceiling entirely and lets every new endpoint stay in its own
   small, single-purpose file — closer to this codebase's existing style.

This is a cost/it's-your-call decision, not a technical one — flagged here
for Rocky/the user to decide, not assumed.
