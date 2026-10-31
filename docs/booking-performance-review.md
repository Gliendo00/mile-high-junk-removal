# Booking controls and Business Performance verification

- Branch: `codex/booking-performance`
- Worktree: `C:/milehighjunkremovalsite/codex-booking-performance`
- Baseline: `931819f`
- No merge, push, deployment, or migration performed.

## Release decision

**Verification accepted by the user; ready for merge review with the documented limitation below.** Local browser create/edit verification passed, but real Supabase-backed authenticated saving is still unverified. The user confirmed that no separate staging/test CRM is available and instructed verification to use local fixtures only, without accessing or modifying production data. This isolated worktree has no backend environment configured. The local verification server deliberately never loads production environment files or writes production data.

| Check | Result |
| --- | --- |
| Real authenticated Supabase create/edit save | UNVERIFIED — no nonproduction authenticated environment is available |
| Local real-page/create/edit/API flow | PASS — fixture auth/storage, unmodified app handlers and auth gate |
| Desktop (1440 × 1000) | PASS |
| Tablet (768 × 1024) | PASS |
| Mobile (390 × 844) | PASS |
| Business Performance data rules | PASS — safe local data and existing regression fixtures |
| Focused regression suites and syntax checks | PASS |
| Full suite | 142/155 files passed; all 13 failing files also fail on baseline |

## Booking save evidence

The browser exercised the actual New Job, booking detail, and Edit Job pages, their production JavaScript, HTTP POST/GET/PATCH requests, and the unmodified booking API handler. The existing offline test harness supplied the Supabase SDK/auth provider and in-memory data. The real requireAdmin gate was exercised: missing cookie returned 401; the fixture session returned 200. This is not a live Supabase authentication or database-persistence check.

| Browser selection | Request exactTime | Simulated PostgreSQL time readback | Result |
| --- | --- | --- | --- |
| 12:00 AM (create) | `00:00` | `00:00:00` | PASS |
| 12:00 PM (edit/reload) | `12:00` | `12:00:00` | PASS |
| 9:15 AM (edit/reload) | `09:15` | `09:15:00` | PASS |
| 1:45 PM (edit/reload) | `13:45` | `13:45:00` | PASS |
| Time Window (edit/reload) | empty | null; `w_1000_1200` window | PASS |
| Back to 12:00 AM (edit/reload) | `00:00` | `00:00:00`; null window | PASS |

All six saves returned 200. Appointment date stayed `2026-11-01` throughout, including midnight on Denver's DST-change date. Inactive time/window values were cleared in the persisted fixture. Stored `13:17:00` also loaded as 1 / 17 / PM. The pure control test round-trips all 1,440 hour/minute combinations.

## Responsive and interaction review

Reviewed actual Edit Job and Website Agent pages visually at all three viewport sizes, with full-page screenshots. Also exercised New Job and Past Job, and visually inspected the Past Job mobile complimentary/exact-time controls.

- Time controls remain aligned, with 46px input heights and no horizontal overflow.
- Complimentary checkbox remains 18px, with a 44px label click target. Checking reveals reason/value/note and disables/clears the collected amount; unchecking re-enables it. Existing server complimentary protections remain covered by regression tests.
- Dashboard range/metric controls have 44px heights and wrap within the page.
- Reviewed Revenue-only, Expenses-only, Job Count-only, and all-off states. The enabled axes and legend now match the plotted metrics.
- 7D, default 30D, and 90D select the expected inclusive Denver date ranges. Resizing redraws the SVG without adding another control instance/listener.
- Existing Search Console/GA4 charts rendered populated local fixtures. Search Console content was unchanged after Business Performance interactions. `admin/website-agent.js` is byte-for-byte unchanged.

## Safe data spot check

Used real existing read handlers backed by safe local test data, then passed their responses into the chart aggregator:

- Junk removal: $400 payment minus $50 refund = $350 revenue.
- Dumpster rental: $500 revenue and one job.
- Auto pickup: shown in schedule data, zero additional jobs/revenue.
- Complimentary completed job: zero revenue, remains one job.
- Active fuel expense: $25. Voided $999 expense excluded.
- Combined chart totals: **$850 revenue, $25 expenses, 3 jobs**.

The chart's pure regression test also covers net-negative refunded revenue and the existing final-price/estimate fallback. No accounting or backend scheduling code changed.

## Fixes during this verification pass

1. Fixed chart legend and axis captions/labels that still advertised disabled metrics, particularly misleading dollar labels in Job Count-only mode. Small dollar ranges retain cents to avoid repeated rounded tick labels.
2. Removed the 403 redirect to nonexistent `/admin/forbidden/`; access failures remain inline.
3. Added accessible group names to the exact-time controls and chart controls.
4. Extended focused tests for rental/junk revenue, pickup count exclusion, refunds, voided expenses, single-metric axes/legend, and denied access.

No new features were added.

## Diff review

Only the requested booking controls, chart, tests, and this report changed. No database, payment, ledger, pricing, scheduling, shared public styling, configuration, or Search Console behavior changes. Small DOM/date/formatting helpers follow existing frontend conventions; chart revenue fallback deliberately matches Schedule's existing rule rather than loading its unrelated sheet UI. No debug logging, dead code, duplicate mounts/listeners, new dependency, or mobile-only workaround found.

## Final files changed

1. `admin/admin.css`
2. `admin/booking-new.js`
3. `admin/booking-new/index.html`
4. `admin/booking-edit.js`
5. `admin/booking-edit/index.html`
6. `admin/booking-past.js`
7. `admin/booking-past/index.html`
8. `admin/time-selector.js` (new)
9. `admin/business-performance.js` (new)
10. `admin/website-agent/index.html`
11. `admin/website-agent/website-agent.css`
12. `tests/booking-performance-ui.test.js` (new)
13. `docs/booking-performance-review.md` (this report)

## Validation

Focused suites: complimentary jobs (25), schedule (77), exact time/quoted range (65), job editing (82), ledger revenue (17), Website Agent dashboard UI, new booking-performance UI, and Search Console snapshots/rendering all passed. Syntax checks passed for all five production JavaScript files and the new test. No lint script/configuration is available in package.json; Node syntax checks were used. `git diff --check` passed.

Both full-suite runs, including the final run after all production fixes, passed 142/155 files. All 13 failing files were independently rerun against an untouched `git archive` of baseline `931819f`. All failure messages matched after normalizing checkout paths. Some are environment/fixture assumptions (including the absent local `.vercel/project.json`), not production changes in this branch.

Pre-existing failing files:

- `agent-completed-job-intake.test.js`
- `agent-firstparty-intake.test.js`
- `agent-runner-phase5.test.js`
- `agent-runner-rotation-evidence.test.js`
- `github-actions-execute-proposal-workflow.test.js`
- `github-actions-workflow.test.js`
- `phase1-api.test.js`
- `phase3a-admin-status-write.test.js`
- `phase3c-batch5-intake-ui.test.js`
- `phase3c-batch6-leads-bucket-audit.test.js`
- `phase3c-batch6-leads-view.test.js`
- `phase3c-batch6-nav-consolidation.test.js`
- `phase4-stage1-dumpster-pickup-auto-job.test.js`

Evidence is saved outside the Git worktree in `C:/Users/RubyF/.codex/visualizations/2026/10/31/01a192cd-fb4c-7be0-8ce6-ed3d3745c383`: save audit JSON, responsive screenshots, browser-check JSON, full-suite logs, and baseline comparison JSON. The disposable localhost server uses existing test fixtures and no real credentials.
