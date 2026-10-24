-- MANUAL Supabase SQL Editor migration. Never executed by the collector.
BEGIN;
CREATE TABLE public.search_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source text NOT NULL CHECK (source IN ('gsc','ga4')),
 property text NOT NULL,
 period_start date NOT NULL,
 period_end date NOT NULL CHECK (period_end >= period_start),
 collected_at timestamptz NOT NULL,
 totals jsonb NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(source,property,period_start,period_end)
);
CREATE INDEX search_snapshots_latest ON public.search_snapshots(source,period_end DESC);
CREATE TABLE public.search_console_queries (
 snapshot_id uuid NOT NULL REFERENCES public.search_snapshots(id) ON DELETE CASCADE,
 query text NOT NULL,
 landing_page text NOT NULL,
 clicks bigint NOT NULL CHECK(clicks >= 0),
 impressions bigint NOT NULL CHECK(impressions >= 0),
 ctr double precision NOT NULL,
 position double precision NOT NULL,
 PRIMARY KEY(snapshot_id,query,landing_page)
);
CREATE INDEX search_queries_top ON public.search_console_queries(snapshot_id,impressions DESC);
CREATE INDEX search_queries_lookup ON public.search_console_queries(query);
CREATE TABLE public.ga4_landing_pages (
 snapshot_id uuid NOT NULL REFERENCES public.search_snapshots(id) ON DELETE CASCADE,
 landing_page text NOT NULL,
 organic_users bigint NOT NULL CHECK(organic_users >= 0),
 organic_sessions bigint NOT NULL CHECK(organic_sessions >= 0),
 engaged_sessions bigint NOT NULL CHECK(engaged_sessions >= 0),
 engagement_rate double precision NOT NULL,
 key_events double precision NOT NULL,
 PRIMARY KEY(snapshot_id,landing_page)
);
CREATE INDEX ga4_pages_top ON public.ga4_landing_pages(snapshot_id,organic_sessions DESC);
CREATE TABLE public.search_collection_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source text NOT NULL CHECK(source IN ('gsc','ga4')),
 property text NOT NULL,
 period_start date NOT NULL,
 period_end date NOT NULL,
 collected_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('success','zero_rows','failed')),
 error_category text
);
CREATE INDEX search_attempts_latest ON public.search_collection_attempts(source,collected_at DESC,period_end DESC);
ALTER TABLE public.search_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_console_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_collection_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_snapshots, public.search_console_queries, public.ga4_landing_pages, public.search_collection_attempts FROM anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.search_snapshots, public.search_console_queries, public.ga4_landing_pages, public.search_collection_attempts TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.search_collection_attempts_id_seq TO service_role;
-- One atomic publication: readers see either the previous complete snapshot or the new complete one.
-- Upsert locks serialize concurrent publications of the same reporting period.
CREATE FUNCTION public.publish_search_snapshot(payload jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE sid uuid; published_at timestamptz;
BEGIN
 INSERT INTO search_snapshots(source,property,period_start,period_end,collected_at,totals,metadata)
 VALUES(payload->>'source',payload->>'property',(payload->>'period_start')::date,(payload->>'period_end')::date,(payload->>'collected_at')::timestamptz,payload->'totals',payload->'metadata')
 ON CONFLICT(source,property,period_start,period_end) DO UPDATE
 SET collected_at=EXCLUDED.collected_at, totals=EXCLUDED.totals,metadata=EXCLUDED.metadata
 WHERE search_snapshots.collected_at <= EXCLUDED.collected_at
 RETURNING id,collected_at INTO sid,published_at;
 IF sid IS NULL THEN RETURN NULL; END IF;
 -- ON CONFLICT DO NOTHING guards against GSC/GA4 returning the same keyed
 -- row twice across paginated pages (no documented stable tie-break for
 -- rows with identical sort metrics) — the preceding DELETE already clears
 -- this snapshot's own prior rows, so a conflict here only ever means a
 -- duplicate within the SAME payload, never stale data; skip it rather than
 -- let the whole atomic publication fail.
 IF payload->>'source'='gsc' THEN
  DELETE FROM search_console_queries WHERE snapshot_id=sid;
  INSERT INTO search_console_queries SELECT sid,r.query,r.landing_page,r.clicks,r.impressions,r.ctr,r.position
  FROM jsonb_to_recordset(payload->'rows') AS r(query text,landing_page text,clicks bigint,impressions bigint,ctr double precision,position double precision)
  ON CONFLICT(snapshot_id,query,landing_page) DO NOTHING;
 ELSE
  DELETE FROM ga4_landing_pages WHERE snapshot_id=sid;
  INSERT INTO ga4_landing_pages SELECT sid,r.landing_page,r.organic_users,r.organic_sessions,r.engaged_sessions,r.engagement_rate,r.key_events
  FROM jsonb_to_recordset(payload->'rows') AS r(landing_page text,organic_users bigint,organic_sessions bigint,engaged_sessions bigint,engagement_rate double precision,key_events double precision)
  ON CONFLICT(snapshot_id,landing_page) DO NOTHING;
 END IF;
 INSERT INTO search_collection_attempts(source,property,period_start,period_end,collected_at,status)
 VALUES(payload->>'source',payload->>'property',(payload->>'period_start')::date,(payload->>'period_end')::date,published_at,CASE WHEN jsonb_array_length(payload->'rows')=0 THEN 'zero_rows' ELSE 'success' END);
 RETURN sid;
END $$;
REVOKE ALL ON FUNCTION public.publish_search_snapshot(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_search_snapshot(jsonb) TO service_role;
COMMIT;
