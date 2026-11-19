#!/usr/bin/env python3
"""Observe logical-decoded commit timestamps locally. This is NOT a reliable materializer."""
import datetime
import pathlib
import re
import subprocess
import uuid
R = pathlib.Path('/home/user/bloom-pg-runtime')
P = str(R/'root/usr/lib/postgresql/17/bin/psql')
base = [P,'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(R/'socket'),'-p','55439']
name = 'bloom_wal_' + uuid.uuid4().hex

def sql(q, db='postgres'):
    p=subprocess.run(base+['-d',db],input=q,text=True,capture_output=True,check=True)
    return p.stdout.strip()

assert sql("SELECT current_setting('listen_addresses') = '' AND inet_server_addr() IS NULL")=='t'
assert sql("SHOW wal_level")=='logical'
assert sql("SHOW track_commit_timestamp")=='off'
try:
    sql(f'CREATE DATABASE {name}')
    sql('CREATE TABLE public.changes(id integer, written_at timestamptz)', name)
    sql(f"SELECT pg_create_logical_replication_slot('{name}','test_decoding')",name)
    sql("BEGIN; INSERT INTO public.changes VALUES (1,clock_timestamp()); SELECT pg_sleep(0.1); COMMIT;",name)
    recorded=datetime.datetime.fromisoformat(sql('SELECT written_at FROM public.changes',name))
    changes=sql(f"SELECT data FROM pg_logical_slot_peek_changes('{name}',NULL,NULL,'include-timestamp','1')",name)
    assert 'INSERT: id[integer]:1' in changes
    timestamp=re.search(r'COMMIT \d+ \(at ([^)]+)\)',changes)
    assert timestamp, changes
    commit=datetime.datetime.fromisoformat(timestamp.group(1))
    assert commit > recorded
    print('PASS: with track_commit_timestamp off, local logical decoding exposed a commit timestamp later than the transaction write timestamp')
    print('LIMIT: peek is observational; no crash-safe capture, acknowledgement, failover, retention, or hosted availability has been established')
finally:
    # The slot belongs to this fresh database and cannot be left retaining WAL.
    sql(f"SELECT pg_drop_replication_slot('{name}') FROM pg_replication_slots WHERE slot_name='{name}'",name)
    sql(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')
