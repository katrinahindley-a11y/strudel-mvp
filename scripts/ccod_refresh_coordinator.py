import datetime as dt
import hashlib
import json
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path
from unittest.mock import patch
from psycopg.types.json import Jsonb
import ccod_import as importer
from ccod_import import SafeError
from ccod_footer_diagnostics import FooterReader
from ccod_refresh_policy import release_month, qualification, retirement_reason, check_retirement_budget
from ccod_refresh_update import apply_title

BUDGET = 768 * 1024 ** 2

def database_bytes(conn):
    return conn.execute('SELECT sum(pg_database_size(datname))::bigint FROM pg_database WHERE datallowconn').fetchone()[0]

def fingerprint(archive, member):
    digest = hashlib.sha256()
    with archive.open(member) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def refresh_archive(conn, archive, resource, today=None):
    month = release_month(resource)
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if month > today.replace(day=1):
        raise SafeError('Future release rejected')
    members = [m for m in archive.infolist() if not m.is_dir() and m.filename.lower().endswith('.csv')]
    if len(members) != 1 or members[0].file_size > 32 * 1024 ** 3:
        raise SafeError('Unexpected ZIP contents or CSV size')
    digest = fingerprint(archive, members[0])
    with conn.transaction():
        conn.execute("SET LOCAL lock_timeout = '30s'")
        conn.execute("SET LOCAL statement_timeout = '30min'")
        importer.guard(conn)
        if not conn.execute('SELECT pg_try_advisory_xact_lock(724310921)').fetchone()[0]:
            raise SafeError('Another CCOD operation is running')
        conn.execute('LOCK TABLE public.property_titles, public.property_proprietors, public.property_charge_matches, ccod_import.refresh_runs, ccod_import.refresh_membership, ccod_import.property_history IN SHARE ROW EXCLUSIVE MODE')
        latest = conn.execute('SELECT snapshot_month, source_count FROM ccod_import.refresh_runs ORDER BY snapshot_month DESC LIMIT 1').fetchone()
        if latest is None:
            raise SafeError('Verified baseline required before refresh')
        if month < latest[0]:
            raise SafeError('Older release rejected')
        prior = conn.execute('SELECT source_sha256, resource_name FROM ccod_import.refresh_runs WHERE snapshot_month = %s', (month,)).fetchone()
        if prior:
            if prior != (digest, resource):
                raise SafeError('Previously applied release has different contents')
            return {'status': 'already_applied', 'snapshot_month': month.isoformat(), 'persistent_changes': False}
        if conn.execute('SELECT EXISTS (SELECT 1 FROM public.property_titles t LEFT JOIN ccod_import.refresh_membership m USING (title_number) WHERE m.title_number IS NULL)').fetchone()[0]:
            raise SafeError('All existing titles require baseline membership')
        members_before = conn.execute('SELECT title_number, managed_high_value, active FROM ccod_import.refresh_membership').fetchall()
        managed = {r[0] for r in members_before if r[1]}
        active_before = {r[0] for r in members_before if r[1] and r[2]}
        observed = {}
        qualified = set()
        source_count = retained_bytes = 0
        with tempfile.TemporaryDirectory() as directory:
            with sqlite3.connect(str(Path(directory) / 'source-titles.sqlite')) as seen:
                seen.execute('CREATE TABLE titles (title TEXT PRIMARY KEY)')
                with patch.object(importer.csv, 'DictReader', FooterReader):
                    for parsed in importer.records(archive, members[0]):
                        title, owners, raw = parsed
                        source_count += 1
                        try:
                            seen.execute('INSERT INTO titles VALUES (?)', (title[0],))
                        except sqlite3.IntegrityError:
                            raise SafeError('Duplicate title in full source') from None
                        qualifies = qualification({'price_paid': title[9]}) == 'qualifies'
                        if qualifies:
                            qualified.add(title[0])
                        if qualifies or title[0] in managed:
                            observed[title[0]] = parsed
                            retained_bytes += len(json.dumps(raw, ensure_ascii=False).encode('utf-8'))
        if not source_count or not qualified:
            raise SafeError('Empty source or qualifying subset rejected')
        if abs(source_count - latest[1]) > max(100, latest[1] // 5):
            raise SafeError('Full source count changed unexpectedly; review required')
        prices = {key: {'price_paid': value[0][9]} for key, value in observed.items()}
        retiring = {title for title in active_before if retirement_reason(title, prices, managed, True) is not None}
        check_retirement_budget(len(active_before), len(retiring))
        if len(qualified - managed) > max(100, len(active_before) // 2):
            raise SafeError('Unexpected qualifying-cohort growth; review required')
        if database_bytes(conn) + max(64 * 1024 ** 2, 8 * retained_bytes) >= BUDGET:
            raise SafeError('Pre-refresh storage headroom insufficient')
        actions = Counter()
        for title in sorted(managed | qualified):
            result = apply_title(conn, month, title, observed.get(title), full_validated=True)
            actions[result['action']] += 1
        active_after = conn.execute('SELECT count(*) FROM ccod_import.refresh_membership WHERE managed_high_value AND active').fetchone()[0]
        if active_after != len(qualified):
            raise SafeError('Final active-cohort count differs from source')
        if database_bytes(conn) + 64 * 1024 ** 2 >= BUDGET:
            raise SafeError('Post-refresh storage headroom insufficient')
        summary = dict(status='applied_in_transaction', snapshot_month=month.isoformat(), source_count=source_count, qualified_count=len(qualified), actions=dict(actions), fingerprint_basis='uncompressed CSV bytes', source_sha256=digest)
        conn.execute('INSERT INTO ccod_import.refresh_runs (snapshot_month, resource_name, source_sha256, source_count, qualified_count, summary) VALUES (%s,%s,%s,%s,%s,%s)', (month, resource, digest, source_count, len(qualified), Jsonb(summary)))
        conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
        importer.guard(conn)
        return summary
