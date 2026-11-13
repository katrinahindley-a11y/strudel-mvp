import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile
from urllib.parse import urlsplit
from unittest.mock import patch
import psycopg
import requests
import ccod_import as importer
from ccod_import import SafeError
from ccod_footer_diagnostics import FooterReader
from ccod_high_value_stage import HOST, RESOURCE, selected_records
from ccod_refresh_coordinator import fingerprint, refresh_archive, database_bytes, BUDGET

MONTH = dt.date(2026, 11, 1)
EXPECTED_SHA256 = '9a2b0529ff81c5ba2402c0b55f4482392abb0647c86fc96247bb0583fdf08bf6'
TABLES = ('ccod_import.refresh_runs', 'ccod_import.refresh_membership', 'ccod_import.property_history')

def tracking_tables(conn):
    return [conn.execute('SELECT to_regclass(%s)', (table,)).fetchone()[0] for table in TABLES]

def property_fingerprints(conn):
    results = []
    for table, order in [('property_titles', 'title_number'), ('property_proprietors', 'title_number,proprietor_position'), ('property_charge_matches', 'id')]:
        results.append(conn.execute(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY {order}), '')) FROM public.{table} t").fetchone()[0])
    return results

def main():
    if os.environ.get('CCOD_BASELINE_SETUP_APPROVAL') != 'NOVEMBER_BASELINE_PERMANENT':
        raise SafeError('Permanent baseline approval missing')
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    importer.check_endpoint(database, HOST)
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        importer.guard(conn)
        if conn.execute('SELECT current_database()').fetchone()[0] != 'neondb' or any(tracking_tables(conn)):
            raise SafeError('Wrong database or refresh tables already exist; review required')
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not key:
        raise SafeError('Land Registry API key missing')
    response = requests.get('https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + RESOURCE, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
    if response.status_code != 200:
        raise SafeError('Download-link request failed')
    payload = response.json()
    url = payload.get('result', {}).get('download_url')
    if payload.get('success') is not True or not isinstance(url, str):
        raise SafeError('Invalid download-link response')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise SafeError('Invalid download-link URL')
    with tempfile.TemporaryFile() as downloaded:
        with requests.get(url, stream=True, timeout=(20, 120), allow_redirects=False) as stream:
            if stream.status_code != 200:
                raise SafeError('Dataset download failed')
            size = 0
            for chunk in stream.iter_content(1024 * 1024):
                size += len(chunk)
                if size > 4 * 1024 ** 3:
                    raise SafeError('ZIP exceeds safety limit')
                downloaded.write(chunk)
        downloaded.seek(0)
        with zipfile.ZipFile(downloaded) as archive:
            members = [m for m in archive.infolist() if not m.is_dir() and m.filename.lower().endswith('.csv')]
            if len(members) != 1 or members[0].file_size > 32 * 1024 ** 3:
                raise SafeError('Unexpected ZIP contents or CSV size')
            source_hash = fingerprint(archive, members[0])
            if source_hash != EXPECTED_SHA256:
                raise SafeError('November source fingerprint differs from rehearsed baseline')
            with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
                with conn.transaction():
                    conn.execute("SET LOCAL lock_timeout = '30s'")
                    conn.execute("SET LOCAL statement_timeout = '30min'")
                    importer.guard(conn)
                    if not conn.execute('SELECT pg_try_advisory_xact_lock(724310921)').fetchone()[0]:
                        raise SafeError('Another CCOD operation is running')
                    conn.execute('LOCK TABLE public.property_titles, public.property_proprietors, public.property_charge_matches IN SHARE ROW EXCLUSIVE MODE')
                    before = importer.counts(conn)
                    before_hashes = property_fingerprints(conn)
                    if before != (17122, 18137, 0) or any(tracking_tables(conn)):
                        raise SafeError('Baseline state changed; review required')
                    batches = conn.execute('SELECT count(*), count(*) FILTER (WHERE price_paid > 5000000) FROM public.property_titles GROUP BY imported_at ORDER BY imported_at').fetchall()
                    if batches != [(435, 23), (1000, 6), (15687, 15687)]:
                        raise SafeError('Import batches differ from independently confirmed baseline')
                    with patch.object(importer, 'records', selected_records), patch.object(importer.csv, 'DictReader', FooterReader):
                        staged = importer.apply_archive(conn, archive, members[0], MONTH, expected=15716, limit=None, write=False)
                    if staged['source_proprietors'] != 16691:
                        raise SafeError('Qualifying proprietor count differs')
                    missing = conn.execute('SELECT count(*) FROM ccod_titles_stage s LEFT JOIN public.property_titles t USING (title_number) WHERE t.title_number IS NULL').fetchone()[0]
                    actual_high = conn.execute('SELECT count(*) FROM public.property_titles WHERE price_paid > 5000000').fetchone()[0]
                    if missing or actual_high != 15716:
                        raise SafeError('Existing qualifying-title set differs from source')
                    stage_bytes = conn.execute("SELECT pg_total_relation_size('pg_temp.ccod_titles_stage') + pg_total_relation_size('pg_temp.ccod_owners_stage')").fetchone()[0]
                    if database_bytes(conn) + 4 * stage_bytes >= BUDGET:
                        raise SafeError('Baseline storage headroom insufficient')
                    conn.execute((Path(__file__).resolve().parents[1] / 'migrations/002_ccod_refresh_state.sql').read_text())
                    conn.execute('INSERT INTO ccod_import.refresh_runs (snapshot_month, resource_name, source_sha256, source_count, qualified_count, summary) VALUES (%s,%s,%s,4485123,15716,%s::jsonb)', (MONTH, RESOURCE, source_hash, '{"mode":"verified_november_baseline","fingerprint_basis":"uncompressed CSV bytes"}'))
                    conn.execute('INSERT INTO ccod_import.refresh_membership (title_number, managed_high_value, retain_sample, active, last_checked_month, last_seen_month) SELECT t.title_number, s.title_number IS NOT NULL, t.imported_at < (SELECT max(imported_at) FROM public.property_titles), true, %s, CASE WHEN s.title_number IS NOT NULL THEN %s::date ELSE NULL END FROM public.property_titles t LEFT JOIN ccod_titles_stage s USING (title_number)', (MONTH, MONTH))
                    cohort = conn.execute('SELECT count(*), count(*) FILTER (WHERE managed_high_value), count(*) FILTER (WHERE retain_sample), count(*) FILTER (WHERE managed_high_value AND retain_sample) FROM ccod_import.refresh_membership').fetchone()
                    if cohort != (17122, 15716, 1435, 29):
                        raise SafeError('Baseline cohort flags incorrect')
                    conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    first = refresh_archive(conn, archive, RESOURCE)
                    if first.get('status') != 'already_applied' or first.get('persistent_changes') is not False:
                        raise SafeError('Same-release no-op check failed')
                if any(tracking_tables(conn)) is False or importer.counts(conn) != before or property_fingerprints(conn) != before_hashes:
                    raise SafeError('Baseline commit verification failed; review required')
                with conn.transaction():
                    second = refresh_archive(conn, archive, RESOURCE)
                    if second.get('status') != 'already_applied' or second.get('persistent_changes') is not False:
                        raise SafeError('Repeat same-release no-op check failed')
                if importer.counts(conn) != before or property_fingerprints(conn) != before_hashes:
                    raise SafeError('Property contents changed during baseline setup; review required')
                report = dict(mode='verified_november_baseline', target=importer.TARGET, source_file=RESOURCE, source_sha256=source_hash, source_count=4485123, managed_titles=cohort[1], retained_sample_titles=cohort[2], overlapping_titles=cohort[3], initial_counts=before, stage_bytes=stage_bytes, first_same_release=first['status'], second_same_release=second['status'], property_contents_unchanged=True, final_counts=importer.counts(conn), tracking_tables_present=True, persistent_changes='tracking baseline only; no property changes', schedule_status='disabled')
                print(json.dumps(report, indent=2))
                print('Permanent November baseline installed. Property data unchanged; monthly schedule remains disabled.')

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD baseline setup stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD baseline setup failed: ' + type(error).__name__ + '; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
