-- LOCAL DEVELOPMENT ONLY. Not a hosted migration. Goals and deletion are not implemented.
-- Requires the four recorded baseline migrations and a verified writer fence.
-- Frozen by default; the test allowlist is for synthetic local users only.
BEGIN;
LOCK TABLE public.habits, public.habit_logs, public.habit_versions IN SHARE ROW EXCLUSIVE MODE;

-- This revocation survives transaction commit. Existing clients cannot write logs afterward.
REVOKE INSERT, UPDATE, DELETE ON public.habits, public.habit_logs FROM PUBLIC, anon, authenticated;

CREATE SCHEMA bloom_private;
REVOKE ALL ON SCHEMA bloom_private FROM PUBLIC, anon, authenticated;
CREATE TABLE bloom_private.controls (id boolean PRIMARY KEY DEFAULT true CHECK (id), frozen boolean NOT NULL DEFAULT true);
INSERT INTO bloom_private.controls(id,frozen) VALUES (true,true);
CREATE TABLE bloom_private.freeze_testers (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
REVOKE ALL ON ALL TABLES IN SCHEMA bloom_private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.habit_versions ADD CONSTRAINT habit_versions_id_owner_key UNIQUE(id, habit_id, user_id);

ALTER TABLE public.habit_logs ADD CONSTRAINT habit_logs_id_owner_key UNIQUE(id,habit_id,user_id);
ALTER TABLE public.habit_logs DROP CONSTRAINT habit_logs_habit_id_user_id_fkey;
ALTER TABLE public.habit_logs ADD CONSTRAINT habit_logs_habit_owner_protect_fkey FOREIGN KEY (habit_id,user_id)
 REFERENCES public.habits(id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.habit_versions DROP CONSTRAINT habit_versions_habit_id_user_id_fkey;
ALTER TABLE public.habit_versions ADD CONSTRAINT habit_versions_habit_owner_protect_fkey FOREIGN KEY (habit_id,user_id)
 REFERENCES public.habits(id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.habit_versions ADD CONSTRAINT habit_versions_auth_user_cascade_fkey FOREIGN KEY (user_id)
 REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE TABLE public.habit_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 habit_id uuid NOT NULL, source text NOT NULL CHECK(source IN ('timed','quick','legacy')),
 status text NOT NULL CHECK(status IN ('running','paused','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, completed_at timestamptz,
 recording_mode text GENERATED ALWAYS AS (CASE WHEN source='legacy' THEN 'imported' WHEN source='quick' AND completed_at IS NULL THEN 'backdated' ELSE 'live' END) STORED,
 completed_on date, duration_ms bigint, estimated_ms bigint, note text,
 start_version_id bigint, completion_version_id bigint, legacy_log_id uuid UNIQUE,
 UNIQUE (id,user_id), UNIQUE (id,habit_id,user_id),
 CONSTRAINT session_habit_fk FOREIGN KEY (habit_id,user_id) REFERENCES public.habits(id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT session_start_version_fk FOREIGN KEY (start_version_id,habit_id,user_id) REFERENCES public.habit_versions(id,habit_id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT session_end_version_fk FOREIGN KEY (completion_version_id,habit_id,user_id) REFERENCES public.habit_versions(id,habit_id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT session_legacy_fk FOREIGN KEY (legacy_log_id,habit_id,user_id) REFERENCES public.habit_logs(id,habit_id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT session_durations_nonnegative CHECK ((duration_ms IS NULL OR duration_ms >= 0) AND (estimated_ms IS NULL OR estimated_ms >= 0)),
 CONSTRAINT session_source_shape CHECK (
  (source='timed' AND started_at IS NOT NULL AND estimated_ms IS NULL AND legacy_log_id IS NULL AND
    ((status IN ('running','paused','cancelled') AND completed_at IS NULL AND completed_on IS NULL AND duration_ms IS NULL) OR
     (status='completed' AND completed_at IS NOT NULL AND completed_on IS NOT NULL AND duration_ms IS NOT NULL))) OR
  (source='quick' AND status='completed' AND started_at IS NULL AND completed_on IS NOT NULL AND duration_ms IS NULL AND legacy_log_id IS NULL) OR
  (source='legacy' AND status='completed' AND started_at IS NULL AND completed_at IS NULL AND completed_on IS NOT NULL AND duration_ms IS NULL AND estimated_ms IS NULL AND legacy_log_id IS NOT NULL))
);
CREATE UNIQUE INDEX sessions_one_unfinished_timer ON public.habit_sessions(user_id) WHERE source='timed' AND status IN ('running','paused');
CREATE INDEX sessions_owner_day_idx ON public.habit_sessions(user_id,completed_on,habit_id) WHERE status='completed';
CREATE TABLE public.habit_session_segments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL, ended_at timestamptz,
 CHECK (ended_at IS NULL OR ended_at >= started_at),
 FOREIGN KEY (session_id,user_id) REFERENCES public.habit_sessions(id,user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX segments_one_open ON public.habit_session_segments(session_id) WHERE ended_at IS NULL;
CREATE INDEX segments_owner_session ON public.habit_session_segments(user_id,session_id);
CREATE TABLE public.session_command_requests (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, request_id uuid NOT NULL,
 operation text NOT NULL, arguments jsonb NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,request_id)
);

ALTER TABLE public.habit_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.habit_session_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_command_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_owner_read ON public.habit_sessions FOR SELECT TO authenticated USING ((SELECT auth.uid())=user_id);
CREATE POLICY segment_owner_read ON public.habit_session_segments FOR SELECT TO authenticated USING ((SELECT auth.uid())=user_id);
REVOKE ALL ON public.habit_sessions,public.habit_session_segments,public.session_command_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.habit_sessions,public.habit_session_segments TO authenticated;
REVOKE ALL ON SEQUENCE public.habit_session_segments_id_seq FROM PUBLIC,anon,authenticated;

-- Preserve every legacy record exactly once; no fabricated completion time or duration.
INSERT INTO public.habit_sessions (user_id,habit_id,source,status,created_at,completed_on,note,legacy_log_id)
 SELECT user_id,habit_id,'legacy','completed',created_at,completed_on,note,id FROM public.habit_logs;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.habit_logs) <> (SELECT count(*) FROM public.habit_sessions WHERE source='legacy') OR EXISTS (
 SELECT 1 FROM public.habit_logs l LEFT JOIN public.habit_sessions s ON s.legacy_log_id=l.id
 WHERE s.id IS NULL OR s.user_id<>l.user_id OR s.habit_id<>l.habit_id OR s.completed_on<>l.completed_on OR s.created_at<>l.created_at OR s.note IS DISTINCT FROM l.note)
 THEN RAISE EXCEPTION 'legacy backfill validation failed'; END IF;
END $$;

-- These helpers are not exposed through PostgREST. Auth identity is read from the JWT,
-- never supplied by the caller. The Auth row lock serializes deletion with writes.
CREATE FUNCTION bloom_private.actor() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid := auth.uid(); f boolean;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
 PERFORM 1 FROM auth.users WHERE id=u FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account no longer exists' USING ERRCODE='28000'; END IF;
 SELECT frozen INTO STRICT f FROM bloom_private.controls WHERE id FOR SHARE;
 IF f AND NOT EXISTS (SELECT 1 FROM bloom_private.freeze_testers WHERE user_id=u) THEN
  RAISE EXCEPTION 'Bloom writes are temporarily frozen' USING ERRCODE='55000';
 END IF;
 RETURN u;
END $$;
REVOKE ALL ON FUNCTION bloom_private.actor() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION bloom_private.session_command(
 p_request uuid, p_operation text, p_habit uuid, p_session uuid,
 p_date date, p_estimated_ms bigint, p_note text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 u uuid; args jsonb; previous public.session_command_requests%ROWTYPE;
 h public.habits%ROWTYPE; s public.habit_sessions%ROWTYPE;
 t timestamptz; vid bigint; sid uuid; result jsonb; measured bigint; changed integer;
BEGIN
 u := bloom_private.actor();
 IF p_request IS NULL THEN RAISE EXCEPTION 'request id is required' USING ERRCODE='22023'; END IF;
 -- One transaction-scoped per-user mutex serializes retries and timer operations.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,19420));
 args := pg_catalog.jsonb_build_object('habit',p_habit,'session',p_session,'date',p_date,'estimated_ms',p_estimated_ms,'note',p_note);
 SELECT * INTO previous FROM public.session_command_requests WHERE user_id=u AND request_id=p_request;
 IF FOUND THEN
  IF previous.operation IS DISTINCT FROM p_operation OR previous.arguments IS DISTINCT FROM args THEN
   RAISE EXCEPTION 'request id reused with different input' USING ERRCODE='22023';
  END IF;
  RETURN previous.response;
 END IF;
 IF p_operation IN ('start','quick') THEN
  SELECT * INTO h FROM public.habits WHERE id=p_habit AND user_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'habit not found' USING ERRCODE='P0002'; END IF;
  IF p_operation IN ('start','quick') AND NOT h.is_active THEN RAISE EXCEPTION 'habit is archived' USING ERRCODE='55000'; END IF;
  t := clock_timestamp();
  SELECT id INTO vid FROM public.habit_versions WHERE user_id=u AND habit_id=h.id ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF vid IS NULL THEN RAISE EXCEPTION 'habit version missing' USING ERRCODE='23514'; END IF;
  IF p_operation='start' THEN
   INSERT INTO public.habit_sessions(user_id,habit_id,source,status,started_at,start_version_id)
    VALUES(u,h.id,'timed','running',t,vid) RETURNING id INTO sid;
   INSERT INTO public.habit_session_segments(session_id,user_id,started_at) VALUES(sid,u,t);
   result := jsonb_build_object('session_id',sid);
  ELSIF p_operation='quick' THEN
   IF p_date IS NULL OR NOT pg_catalog.isfinite(p_date) OR p_date < DATE '0001-01-01' OR p_date > (t AT TIME ZONE 'Africa/Lagos')::date OR p_estimated_ms < 0 OR p_estimated_ms > 9007199254740991 OR char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'invalid quick log date or duration' USING ERRCODE='22023';
   END IF;
   INSERT INTO public.habit_sessions(user_id,habit_id,source,status,completed_at,completed_on,estimated_ms,note,completion_version_id)
    VALUES(u,h.id,'quick','completed',CASE WHEN p_date=(t AT TIME ZONE 'Africa/Lagos')::date THEN t ELSE NULL END,p_date,p_estimated_ms,p_note,vid)
    RETURNING id INTO sid;
   result := jsonb_build_object('session_id',sid);
  END IF;
 ELSIF p_operation IN ('pause','resume','complete','cancel') THEN
  SELECT * INTO s FROM public.habit_sessions WHERE id=p_session AND user_id=u AND source='timed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'timer not found' USING ERRCODE='P0002'; END IF;
  IF s.status NOT IN ('running','paused') THEN RAISE EXCEPTION 'timer is already finished' USING ERRCODE='55000'; END IF;
  t := clock_timestamp();
  IF p_operation='pause' AND s.status<>'running' THEN RAISE EXCEPTION 'timer is not running' USING ERRCODE='55000'; END IF;
  IF p_operation='resume' AND s.status<>'paused' THEN RAISE EXCEPTION 'timer is not paused' USING ERRCODE='55000'; END IF;
  IF s.status='running' AND p_operation IN ('pause','complete','cancel') THEN
   UPDATE public.habit_session_segments SET ended_at=t WHERE session_id=s.id AND user_id=u AND ended_at IS NULL;
   GET DIAGNOSTICS changed = ROW_COUNT;
   IF changed<>1 THEN RAISE EXCEPTION 'invalid running timer segments' USING ERRCODE='23514'; END IF;
  END IF;
  IF p_operation='resume' THEN
   INSERT INTO public.habit_session_segments(session_id,user_id,started_at) VALUES(s.id,u,t);
   UPDATE public.habit_sessions SET status='running' WHERE id=s.id;
  ELSIF p_operation='pause' THEN
   UPDATE public.habit_sessions SET status='paused' WHERE id=s.id;
  ELSIF p_operation='cancel' THEN
   UPDATE public.habit_sessions SET status='cancelled' WHERE id=s.id;
  ELSE
   SELECT coalesce(sum(floor(extract(epoch FROM (ended_at-started_at))*1000)::bigint),0)::bigint INTO measured
    FROM public.habit_session_segments WHERE session_id=s.id AND user_id=u AND ended_at IS NOT NULL;
   SELECT id INTO vid FROM public.habit_versions WHERE habit_id=s.habit_id AND user_id=u ORDER BY recorded_at DESC,id DESC LIMIT 1;
   IF vid IS NULL THEN RAISE EXCEPTION 'habit version missing' USING ERRCODE='23514'; END IF;
   UPDATE public.habit_sessions SET status='completed',completed_at=t,completed_on=(t AT TIME ZONE 'Africa/Lagos')::date,
    duration_ms=measured,completion_version_id=vid WHERE id=s.id;
  END IF;
  result := jsonb_build_object('session_id',s.id);
 ELSE
  RAISE EXCEPTION 'unsupported session action' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.session_command_requests(user_id,request_id,operation,arguments,response) VALUES(u,p_request,p_operation,args,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION bloom_private.session_command(uuid,text,uuid,uuid,date,bigint,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.bloom_start_session(p_request_id uuid,p_habit_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'start',p_habit_id,NULL,NULL,NULL,NULL) $$;
CREATE FUNCTION public.bloom_pause_session(p_request_id uuid,p_session_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'pause',NULL,p_session_id,NULL,NULL,NULL) $$;
CREATE FUNCTION public.bloom_resume_session(p_request_id uuid,p_session_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'resume',NULL,p_session_id,NULL,NULL,NULL) $$;
CREATE FUNCTION public.bloom_complete_session(p_request_id uuid,p_session_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'complete',NULL,p_session_id,NULL,NULL,NULL) $$;
CREATE FUNCTION public.bloom_cancel_session(p_request_id uuid,p_session_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'cancel',NULL,p_session_id,NULL,NULL,NULL) $$;
CREATE FUNCTION public.bloom_quick_log(p_request_id uuid,p_habit_id uuid,p_date date,p_estimated_ms bigint DEFAULT NULL,p_note text DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.session_command(p_request_id,'quick',p_habit_id,NULL,p_date,p_estimated_ms,p_note) $$;
REVOKE ALL ON FUNCTION public.bloom_start_session(uuid,uuid),public.bloom_pause_session(uuid,uuid),public.bloom_resume_session(uuid,uuid),public.bloom_complete_session(uuid,uuid),public.bloom_cancel_session(uuid,uuid),public.bloom_quick_log(uuid,uuid,date,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_start_session(uuid,uuid),public.bloom_pause_session(uuid,uuid),public.bloom_resume_session(uuid,uuid),public.bloom_complete_session(uuid,uuid),public.bloom_cancel_session(uuid,uuid),public.bloom_quick_log(uuid,uuid,date,bigint,text) TO authenticated;

-- Habit mutations use the same per-user mutex, freeze gate and idempotency ledger.
-- This keeps obsolete clients fenced instead of regranting old direct writes on release.
CREATE FUNCTION bloom_private.habit_command(p_request uuid,p_operation text,p_habit uuid,p_name text,p_description text,p_time time)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid; args jsonb; previous public.session_command_requests%ROWTYPE; h public.habits%ROWTYPE; result jsonb;
BEGIN
 u := bloom_private.actor();
 IF p_request IS NULL THEN RAISE EXCEPTION 'request id is required' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,19420));
 args := pg_catalog.jsonb_build_object('habit',p_habit,'name',p_name,'description',p_description,'time',p_time);
 SELECT * INTO previous FROM public.session_command_requests WHERE user_id=u AND request_id=p_request;
 IF FOUND THEN
  IF previous.operation IS DISTINCT FROM p_operation OR previous.arguments IS DISTINCT FROM args THEN
   RAISE EXCEPTION 'request id reused with different input' USING ERRCODE='22023';
  END IF;
  RETURN previous.response;
 END IF;
 IF p_operation IN ('habit_create','habit_update') AND (p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120 OR char_length(p_description)>500) THEN
  RAISE EXCEPTION 'invalid habit fields' USING ERRCODE='22023';
 END IF;
 IF p_operation='habit_create' THEN
  INSERT INTO public.habits(user_id,name,description,preferred_time,frequency,target_per_week)
   VALUES (u,btrim(p_name),p_description,p_time,'daily',NULL) RETURNING * INTO h;
 ELSIF p_operation IN ('habit_update','habit_archive') THEN
  SELECT * INTO h FROM public.habits WHERE id=p_habit AND user_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'habit not found' USING ERRCODE='P0002'; END IF;
  IF NOT h.is_active THEN RAISE EXCEPTION 'habit is archived' USING ERRCODE='55000'; END IF;
  IF p_operation='habit_update' THEN
   UPDATE public.habits SET name=btrim(p_name),description=p_description,preferred_time=p_time WHERE id=h.id AND user_id=u RETURNING * INTO h;
  ELSE
   UPDATE public.habits SET is_active=false WHERE id=h.id AND user_id=u RETURNING * INTO h;
  END IF;
 ELSE RAISE EXCEPTION 'unsupported habit action' USING ERRCODE='22023';
 END IF;
 result := pg_catalog.jsonb_build_object('habit_id',h.id);
 INSERT INTO public.session_command_requests(user_id,request_id,operation,arguments,response) VALUES(u,p_request,p_operation,args,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION bloom_private.habit_command(uuid,text,uuid,text,text,time) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.bloom_create_habit(p_request_id uuid,p_name text,p_description text DEFAULT NULL,p_time time DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.habit_command(p_request_id,'habit_create',NULL,p_name,p_description,p_time) $$;
CREATE FUNCTION public.bloom_update_habit(p_request_id uuid,p_habit_id uuid,p_name text,p_description text DEFAULT NULL,p_time time DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.habit_command(p_request_id,'habit_update',p_habit_id,p_name,p_description,p_time) $$;
CREATE FUNCTION public.bloom_archive_habit(p_request_id uuid,p_habit_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT bloom_private.habit_command(p_request_id,'habit_archive',p_habit_id,NULL,NULL,NULL) $$;
REVOKE ALL ON FUNCTION public.bloom_create_habit(uuid,text,text,time),public.bloom_update_habit(uuid,uuid,text,text,time),public.bloom_archive_habit(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_create_habit(uuid,text,text,time),public.bloom_update_habit(uuid,uuid,text,text,time),public.bloom_archive_habit(uuid,uuid) TO authenticated;

-- Fail closed if inherited, PUBLIC, table-level or column-level grants bypass the fence.
-- This cannot detect external privileged writers; the runbook must inventory and stop them.
CREATE FUNCTION bloom_private.assert_frozen_grants() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text; tab text; privilege_name text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_schema_privilege(r,'bloom_private','USAGE') THEN
   RAISE EXCEPTION 'unexpected private schema usage for %',r USING ERRCODE='42501';
  END IF;
  FOREACH tab IN ARRAY ARRAY['public.habits','public.habit_logs','public.habit_sessions','public.habit_session_segments','public.session_command_requests'] LOOP
   FOREACH privilege_name IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
    IF has_table_privilege(r,tab,privilege_name) OR (privilege_name <> 'DELETE' AND has_any_column_privilege(r,tab,privilege_name)) THEN
     RAISE EXCEPTION 'unexpected % privilege on % for %',privilege_name,tab,r USING ERRCODE='42501';
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION bloom_private.assert_frozen_grants() FROM PUBLIC,anon,authenticated;

-- Owner-only operational functions: ordinary authenticated callers have no schema usage or execute.
CREATE FUNCTION bloom_private.freeze_writes() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 -- Lock gate before habit tables: in-flight RPCs hold a share lock on the gate.
 UPDATE bloom_private.controls SET frozen=true WHERE id;
 LOCK TABLE public.habits,public.habit_logs IN SHARE ROW EXCLUSIVE MODE;
 REVOKE INSERT,UPDATE,DELETE ON public.habits,public.habit_logs FROM PUBLIC,anon,authenticated;
 REVOKE INSERT (user_id,name,description,frequency,target_per_week,color,icon,is_active,preferred_time) ON public.habits FROM authenticated;
 REVOKE UPDATE (name,description,frequency,target_per_week,color,icon,is_active,preferred_time) ON public.habits FROM authenticated;
 PERFORM bloom_private.assert_frozen_grants();
END $$;
CREATE FUNCTION bloom_private.release_writes() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 -- The obsolete dashboard remains fenced, even after new RPCs are released.
 PERFORM bloom_private.assert_frozen_grants();
 UPDATE bloom_private.controls SET frozen=false WHERE id;
END $$;
REVOKE ALL ON FUNCTION bloom_private.freeze_writes(),bloom_private.release_writes() FROM PUBLIC,anon,authenticated;

SELECT bloom_private.assert_frozen_grants();
COMMIT;
