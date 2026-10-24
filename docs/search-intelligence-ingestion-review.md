# Search Intelligence ingestion review — 2026-10-22

Branch: `codex/search-intelligence-ingestion`; base commit `0dfe9b6`.
Continued the existing dirty task checkout without resetting, stashing, merging,
pushing, deploying, applying SQL, or invoking the live collector.

## Implementation and scope

Existing work adds normalized GSC query/page and GA4 organic landing-page reports,
separate report-level totals, two adjacent 28-day windows ending three days ago,
pagination, per-source failure records, last-successful fallback, and dashboard
tables with reporting dates, collection timestamps, stale notices and limitations.
Collection is a separate daily/weekly Actions step; dashboard requests only read
stored data after existing admin authentication. No scoring, decision, proposal,
public-site tracking, booking or payment behavior was changed. The shared
`api/admin/bookings.js` diff concerns only its agent-dashboard view.

Continuation fixes isolate thrown failure-log writes so all four source/window
collections still run, and make invalid Supabase client configuration return
`storage_error` instead of rejecting the dashboard. Added regression cases and
corrected obsolete comments about the dashboard never reading Supabase.

## Migration and exact manual steps

File: `sql/2026-10-22_search-intelligence-snapshots.sql`.
Creates `search_snapshots`, `search_console_queries`, `ga4_landing_pages`,
`search_collection_attempts`, their indexes and the attempts identity sequence.
Creates `publish_search_snapshot(jsonb)`: atomic snapshot upsert, child-row
replacement and successful-attempt logging. Older publications cannot overwrite
a newer collection of the same period. Unique keys prevent duplicate snapshots
and duplicate dimension rows. Failed collection leaves successful data intact.
Enables RLS on all four tables, revokes anon/authenticated table privileges,
grants service-role access, and restricts function execution to service_role.
Uses SECURITY INVOKER. Existing business tables are untouched.

1. First use a disposable Supabase project with no existing objects of these
   names. Inspect the entire migration and confirm the intended project.
2. In its SQL Editor paste the complete file including BEGIN and COMMIT, then
   run once. This is not an idempotent migration: do not blindly rerun it.
3. Confirm all four tables, indexes, enabled RLS, and service-only grants. Verify
   anonymous/authenticated reads and RPC calls are denied. Exercise RPC success,
   duplicate publication, stale publication and rollback after invalid child rows
   using synthetic payloads. These database execution checks remain outstanding.
4. Only after review and explicit production authorization, repeat the complete
   migration in the intended production Supabase project and record application.
5. Verify collector and admin use the same Supabase project. Do not trigger the
   collector until migration, credentials and explicit collection safety approval
   are established. No migration or live collection was performed here.

## Environment and Google configuration

Collector requires `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server-only service
credential), `GSC_SITE_URL` (exact property identifier) and `GA4_PROPERTY_ID`
(numeric property ID). Preferred keyless auth uses
`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` and ADC. Actions additionally needs repository
variable `GCP_WORKLOAD_IDENTITY_PROVIDER`; its existing auth action supplies
`GOOGLE_APPLICATION_CREDENTIALS`. Local ADC may use the well-known gcloud file or
that variable. `GOOGLE_SERVICE_ACCOUNT_JSON` is a supported legacy alternative,
not a requirement; do not create keys for this work.

Actions vars: GCP_WORKLOAD_IDENTITY_PROVIDER,
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, GSC_SITE_URL, GA4_PROPERTY_ID.
Actions secrets: SUPABASE_URL, SUPABASE_SECRET_KEY.
Admin runtime already needs Supabase and existing admin-auth configuration; it
does not need Google credentials. Optional property vars on admin scope snapshot
reads to the intended property; when absent, the current implementation selects
the latest stored report across properties for that source. Keep one property per
source/project or explicitly configure this filter.

Enable Search Console API, Analytics Data API and IAM Service Account Credentials
API in the appropriate Google Cloud project. Retain the existing restricted WIF
trust and permit the federated identity/local ADC principal to mint access tokens
for the target service account (IAM Credentials generateAccessToken permission).
Do not broaden trust to unrelated repositories or refs.

Search Console: verify the intended domain or URL-prefix property, add the target
service-account email under Users and permissions with access to performance
reports (Full user is sufficient), and set GSC_SITE_URL exactly, including
`sc-domain:` or the URL-prefix trailing slash. Client uses webmasters.readonly.

GA4: add that service-account email in Property Access Management with Viewer
access, set the numeric property ID rather than a G- measurement ID, and verify
the property is receiving site events. Client uses analytics.readonly. Reports
filter sessionDefaultChannelGroup to Organic Search. Tracked observations are
phone_click, sms_click, booking_started, booking_service_selected,
booking_date_selected and booking_form_completed. Verify instrumentation and
property key-event settings manually; the code deliberately leaves conversion
mapping unresolved and does not call key events verified booking conversions.

Sources: [GA4 API setup](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart),
[Search Console authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing),
[GSC query constraints](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[GA4 pagination](https://developers.google.com/analytics/devguides/reporting/data/v1/basics).

## Limitations

SQL received static review only; no PostgreSQL engine was available in this
checkout. No real Google responses, WIF permissions, production configuration or
browser layout were verified. GA4 thresholds/modeling and GSC omitted queries
mean row sums need not equal totals; users must not be summed across landing
pages. Previous-period snapshots are stored but comparison deltas are not yet
displayed. Attempts and rolling-period snapshots currently have no retention
policy. Workflow collection uses continue-on-error; inspect its failed step and
dashboard status because overall job success does not imply ingestion success.

## Final verification

Node v24.19.0; 148 test files executed serially: 138 pass, 10 fail.
The same ten files fail at the unchanged `0dfe9b6` baseline:

- agent-completed-job-intake: assumes committed job evidence is empty.
- agent-firstparty-intake: assumes Golden has no operational evidence.
- agent-runner-phase5: simulated scan failure uses a hardcoded checkout path.
- github-actions-workflow: CRLF-sensitive regex and absent local .vercel/project.json.
- phase1-api: honeypot/fast-submission expectations.
- phase3a-admin-status-write: outdated write-call audit expectation.
- phase3c-batch5-intake-ui: route and notes/price expectations.
- phase3c-batch6-leads-bucket-audit: bucket/status expectations.
- phase3c-batch6-leads-view: website-origin section expectations.
- phase3c-batch6-nav-consolidation: old merged-view expectation.

Did not rewrite these unrelated baseline tests or business code to make the
suite green. Initial run lacked dependencies; offline install lacked cached
tslib and network install was unavailable. Final runs used the existing site's
installed dependencies through NODE_PATH, without changing the lockfile.
Three tests exceeded an initial 20-second cap; finding-evidence refresh,
runner-resume and safe-commit all pass when rerun with a 120-second cap.
Temporary research files were cleaned and original tracked research restored.

Snapshot suite passes normalization, current/previous periods, source totals,
repeat-publication storage contract (mock DB), failure vs valid empty results,
last-successful fallback, mixed source outcomes, GSC/GA4 pagination, incomplete
GA4 rejection, optional event failure, thrown attempt-log writes, invalid
Supabase client configuration, actual renderer execution using a minimal DOM,
and static SQL guards. Dashboard API tests (16 cases), existing Google-client
tests and dashboard UI regression tests pass. Modified JavaScript syntax and
git diff whitespace checks pass. DOM execution is not browser visual QA.

Ready for code review. Do not merge yet: first validate the migration and its
permissions/atomicity against disposable PostgreSQL/Supabase and resolve or
explicitly accept the documented baseline regression failures. Production
migration, Google credentials/permissions, live collection and layout remain
unverified. Nothing was pushed, merged or deployed.
