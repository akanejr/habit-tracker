#!/usr/bin/env python3
"""Synthetic PostgreSQL integration tests; requires the disposable UNIX-socket-only server.

This is not a Supabase Auth/PostgREST test. Never point it at a hosted database.
"""
import concurrent.futures
import json
import pathlib
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = pathlib.Path('/home/user/bloom-pg-runtime')
PSQL = RUNTIME / 'root/usr/lib/postgresql/17/bin/psql'
SOCKET = RUNTIME / 'socket'
BASE = [str(PSQL), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(SOCKET), '-p', '55439']
DB = 'bloom_test_' + uuid.uuid4().hex
A = '00000000-0000-4000-8000-000000000001'
B = '00000000-0000-4000-8000-000000000002'
HA = '10000000-0000-4000-8000-000000000001'
HB = '10000000-0000-4000-8000-000000000002'

def sql(query, *, database=DB, ok=True):
    p = subprocess.run(BASE + ['-d', database], input=query, text=True, capture_output=True)
    if ok and p.returncode:
        raise AssertionError(f'SQL unexpectedly failed: {p.stderr}\n{query}')
    if not ok and not p.returncode:
        raise AssertionError(f'SQL unexpectedly succeeded: {query}')
    return p.stdout.strip() if ok else p.stderr

def actor(user, query):
    return f"SET ROLE authenticated; SET request.jwt.claim.sub = '{user}'; {query}"

def invoke(user, query, ok=True): return sql(actor(user, query), ok=ok)
def req(): return str(uuid.uuid4())
def check(condition, description):
    assert condition, description
    print('PASS', description)

def setup():
    # Verify connection is a UNIX socket and the instance cannot accept TCP connections.
    check(sql("SELECT current_setting('listen_addresses') = '' AND inet_server_addr() IS NULL", database='postgres') == 't', 'disposable local UNIX-socket-only server')
    sql("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$", database='postgres')
    sql(f'CREATE DATABASE {DB}', database='postgres')
    sql("""CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;""")
    for path in sorted((ROOT/'supabase/migrations').glob('*.sql')):
        sql(path.read_text())
    sql(f"""INSERT INTO auth.users(id,email) VALUES ('{A}','alpha@example.invalid'),('{B}','beta@example.invalid');
    INSERT INTO public.habits(id,user_id,name) VALUES ('{HA}','{A}','Read'),('{HB}','{B}','Move');
    INSERT INTO public.habit_logs(id,habit_id,user_id,completed_on,note) VALUES ('20000000-0000-4000-8000-000000000001','{HA}','{A}','2026-01-01','legacy');""")
    sql((ROOT/'supabase/local-only/session_foundation.sql').read_text())

def run():
    check(sql("SELECT count(*) FROM public.habit_sessions WHERE source='legacy' AND note='legacy' AND duration_ms IS NULL AND estimated_ms IS NULL") == '1', 'legacy backfill preserves data without invented duration')
    check('temporarily frozen' in invoke(A, f"SELECT public.bloom_start_session('{req()}','{HA}')",ok=False), 'new writes frozen by default')
    check('permission denied' in invoke(A, f"UPDATE public.habits SET name='bypass' WHERE id='{HA}'",ok=False), 'legacy habit edits fenced')
    check('permission denied' in invoke(A, f"INSERT INTO public.habit_logs(habit_id,user_id,completed_on) VALUES ('{HA}','{A}',current_date)",ok=False), 'legacy log writes fenced')
    sql(f"INSERT INTO bloom_private.freeze_testers(user_id) VALUES ('{A}'),('{B}')")
    check(invoke(B,"SELECT count(*) FROM public.habit_sessions") == '0','owner RLS prevents reading other sessions')
    check('habit not found' in invoke(B, f"SELECT public.bloom_start_session('{req()}','{HA}')",ok=False), 'cross-owner timer start rejected')
    check('permission denied' in invoke(A,f"DELETE FROM public.habits WHERE id='{HA}'",ok=False), 'authenticated physical deletion denied')
    check('permission denied' in invoke(A,"DELETE FROM public.habit_sessions",ok=False), 'direct session writes denied')
    check('permission denied' in sql(f"SET ROLE anon; SELECT public.bloom_start_session('{req()}','{HA}')",ok=False), 'anonymous session commands denied')
    err=sql(f"BEGIN; DELETE FROM public.habits WHERE id='{HA}'; COMMIT;",ok=False)
    check('violates foreign key constraint' in err,'privileged standalone habit deletion blocked by preserved history')
    start=req(); session=json.loads(invoke(A,f"SELECT public.bloom_start_session('{start}','{HA}')"))['session_id']
    check(json.loads(invoke(A,f"SELECT public.bloom_start_session('{start}','{HA}')"))['session_id']==session,'start retry is idempotent')
    check('request id reused' in invoke(A,f"SELECT public.bloom_start_session('{start}','{HB}')",ok=False),'same request with changed arguments rejected')
    check('duplicate key' in invoke(A,f"SELECT public.bloom_start_session('{req()}','{HA}')",ok=False), 'only one running or paused timer')
    q=req(); query=f"SELECT public.bloom_quick_log('{q}','{HA}','2026-01-02',120000,'backdated')"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outputs=list(pool.map(lambda _: invoke(A,query), range(2)))
    check(outputs[0] == outputs[1] and sql(f"SELECT count(*) FROM public.habit_sessions WHERE source='quick' AND user_id='{A}'")=='1','concurrent quick-log retries create one record')
    check('invalid quick log date' in invoke(A,f"SELECT public.bloom_quick_log('{req()}','{HA}','9999-01-01')",ok=False),'future quick log rejected')
    invoke(A,f"SELECT public.bloom_pause_session('{req()}','{session}')")
    check(sql(f"SELECT status FROM public.habit_sessions WHERE id='{session}'")=='paused','timer pause persists')
    invoke(A,f"SELECT public.bloom_resume_session('{req()}','{session}')")
    sql(f"UPDATE public.habits SET is_active=false WHERE id='{HA}'")
    check('archived' in invoke(A,f"SELECT public.bloom_quick_log('{req()}','{HA}','2026-01-02')",ok=False),'archived habit blocks new sessions')
    invoke(A,f"SELECT public.bloom_complete_session('{req()}','{session}')")
    check(sql(f"SELECT status='completed' AND duration_ms>=0 AND completed_on=(completed_at AT TIME ZONE 'Africa/Lagos')::date FROM public.habit_sessions WHERE id='{session}'")=='t','archived timer completes with server duration and Lagos date')
    check(sql(f"SELECT count(*) FROM public.habit_session_segments WHERE session_id='{session}' AND ended_at IS NOT NULL")=='2','pause/resume stores separate active segments')
    check(sql(f"SELECT count(*) FROM public.habit_sessions WHERE user_id='{A}' AND status='completed'")=='3','quick log coexists with timer and legacy backfill')
    create_id=req(); create_q=f"SELECT public.bloom_create_habit('{create_id}',' Journal ',NULL,'09:30')"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        created=list(pool.map(lambda _: invoke(A,create_q),range(2)))
    created_habit=json.loads(created[0])['habit_id']
    check(created[0]==created[1] and sql(f"SELECT count(*) FROM public.habits WHERE user_id='{A}' AND name='Journal'")=='1','habit creation retries are idempotent')
    check('habit not found' in invoke(B,f"SELECT public.bloom_archive_habit('{req()}','{created_habit}')",ok=False),'cross-owner habit archive rejected')
    invoke(A,f"SELECT public.bloom_update_habit('{req()}','{created_habit}','Journal daily','updated','10:30')")
    check(sql(f"SELECT count(*) FROM public.habit_versions WHERE habit_id='{created_habit}'")=='2','habit edits retain version history')
    for _ in range(14): invoke(A,f"SELECT public.bloom_quick_log('{req()}','{created_habit}','2026-01-02',60000,NULL)")
    check(sql(f"SELECT count(*)=14 AND count(DISTINCT completed_on)=1 AND sum(estimated_ms)=840000 FROM public.habit_sessions WHERE habit_id='{created_habit}'")=='t','fourteen sessions on one day and separate estimated durations')
    check('invalid quick log date' in invoke(A,f"SELECT public.bloom_quick_log('{req()}','{created_habit}','2026-01-02',-1,NULL)",ok=False),'server rejects negative estimates')
    check('invalid quick log date' in invoke(A,f"SELECT public.bloom_quick_log('{req()}','{created_habit}','-infinity',0,NULL)",ok=False),'server rejects nonfinite dates')
    check('invalid quick log date' in invoke(A,f"SELECT public.bloom_quick_log('{req()}','{created_habit}','2026-01-02',0,repeat('x',501))",ok=False),'server rejects oversized notes')
    sql('SELECT bloom_private.release_writes()')
    check('permission denied' in invoke(A, f"UPDATE public.habits SET name='old client' WHERE id='{created_habit}'",ok=False),'release keeps obsolete habit edits fenced')
    check('permission denied' in invoke(A,f"DELETE FROM public.habits WHERE id='{HA}'",ok=False), 'release does not restore habit deletion')
    sql('SELECT bloom_private.freeze_writes()')
    check('permission denied' in invoke(A,f"UPDATE public.habits SET name='bypass' WHERE id='{HA}'",ok=False), 'refreeze revokes habit update')
    sql(f"CREATE TABLE public.deletion_guard(user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT); INSERT INTO public.deletion_guard VALUES ('{A}')")
    err=sql(f"DELETE FROM auth.users WHERE id='{A}'",ok=False)
    check('violates foreign key' in err and sql(f"SELECT count(*) FROM public.habit_sessions WHERE user_id='{A}'")=='17','failed Auth deletion rolls back every cascade')
    sql('DROP TABLE public.deletion_guard')
    sql(f"DELETE FROM auth.users WHERE id='{A}'")
    check(sql(f"SELECT (SELECT count(*) FROM public.habits WHERE user_id='{A}') + (SELECT count(*) FROM public.habit_sessions WHERE user_id='{A}') + (SELECT count(*) FROM public.habit_session_segments WHERE user_id='{A}') + (SELECT count(*) FROM public.session_command_requests WHERE user_id='{A}') + (SELECT count(*) FROM public.habit_logs WHERE user_id='{A}') + (SELECT count(*) FROM public.habit_versions WHERE user_id='{A}')")=='0','synthetic Auth deletion cascades through all session relationships')
    check('account no longer exists' in invoke(A,f"SELECT public.bloom_start_session('{req()}','{HA}')",ok=False),'stale identity cannot recreate sessions')
    check(invoke(A,'SELECT count(*) FROM public.habit_sessions')=='0','stale identity cannot read deleted sessions')
    check(sql(f"SELECT count(*) FROM auth.users WHERE id='{B}'")=='1','other synthetic user remains intact')
    # Start and archive share a mutex. Archive may win or follow a successful start;
    # both serial orders preserve the invariant that starts never occur after archive.
    for _ in range(8):
        hh=json.loads(invoke(B,f"SELECT public.bloom_create_habit('{req()}','Race habit')"))['habit_id']
        start_sql=f"SELECT public.bloom_start_session('{req()}','{hh}')"
        archive_sql=f"SELECT public.bloom_archive_habit('{req()}','{hh}')"
        def try_start():
            try: return invoke(B,start_sql)
            except AssertionError as e:
                if 'archived' not in str(e): raise
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            sf=pool.submit(try_start); af=pool.submit(invoke,B,archive_sql); started=sf.result(); af.result()
        check(sql(f"SELECT is_active FROM public.habits WHERE id='{hh}'")=='f','concurrent start/archive leaves habit archived')
        check('archived' in invoke(B,f"SELECT public.bloom_start_session('{req()}','{hh}')",ok=False),'start rejected after concurrent archive')
        if started:
            sid=json.loads(started)['session_id']; invoke(B,f"SELECT public.bloom_cancel_session('{req()}','{sid}')")
    # Race a command against an Auth deletion, then verify no data recreation.
    query=f"SELECT public.bloom_quick_log('{req()}','{HB}','2026-01-02')"
    def racing_write():
        try: invoke(B,query)
        except AssertionError as e:
            if 'account no longer exists' not in str(e): raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        w=pool.submit(racing_write); d=pool.submit(sql,f"DELETE FROM auth.users WHERE id='{B}'"); w.result(); d.result()
    check(sql(f"SELECT count(*) FROM public.habit_sessions WHERE user_id='{B}'")=='0','concurrent Auth deletion leaves no recreated sessions')
    check('account no longer exists' in invoke(B,f"SELECT public.bloom_create_habit('{req()}','recreate')",ok=False),'stale identity cannot recreate habits')

if __name__ == '__main__':
    try:
        setup(); run()
    finally:
        sql(f'DROP DATABASE IF EXISTS {DB} WITH (FORCE)', database='postgres')
