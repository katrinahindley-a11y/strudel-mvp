import datetime as dt
import json
import os
import re
import sys
import tempfile
import zipfile
from urllib.parse import urlsplit
import psycopg
import requests
import ccod_import as importer
from ccod_import import SafeError
from ccod_footer_diagnostics import FooterReader
from ccod_high_value_stage import HOST
from ccod_refresh_coordinator import fingerprint, refresh_archive, database_bytes, BUDGET

BASELINE_MONTH = dt.date(2026, 11, 1)
BASELINE_SHA256 = '9a2b0529ff81c5ba2402c0b55f4482392abb0647c86fc96247bb0583fdf08bf6'
API_BASE = 'https://use-land-property-data.service.gov.uk/api/v1'
FULL_NAME = re.compile(r'^CCOD_FULL_(\d{4})_(\d{2})\.zip$')

def tracking_counts(conn):
    return (
        conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0],
        conn.execute('SELECT count(*) FROM ccod_import.refresh_membership').fetchone()[0],
        conn.execute('SELECT count(*) FROM ccod_import.property_history').fetchone()[0],
    )

def property_fingerprints(conn):
    results = []
    for table, order in [('property_titles', 'title_number'), ('property_proprietors', 'title_number,proprietor_position'), ('property_charge_matches', 'id')]:
        results.append(conn.execute(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY {order}), '')) FROM public.{table} t").fetchone()[0])
    return results

def latest_full_resource(payload):
    resources = payload.get('result', {}).get('resources')
    if payload.get('success') is not True or not isinstance(resources, list):
        raise SafeError('Invalid CCOD dataset metadata response')
    candidates = []
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        name = resource.get('file_name') or resource.get('name')
        match = FULL_NAME.fullmatch(name) if isinstance(name, str) else None
        if match:
            candidates.append((dt.date(int(match.group(1)), int(match.group(2)), 1), name))
    if not candidates:
        raise SafeError('No full CCOD release found in dataset metadata')
    return max(candidates)

def main():
    if os.environ.get('CCOD_APPLY_NEWER_RELEASE_APPROVAL') != 'NEWER_RELEASE_ONLY':
        raise SafeError('Manual newer-release approval missing')
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    importer.check_endpoint(database, HOST)
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not key:
        raise SafeError('Land Registry API key missing')
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        importer.guard(conn)
        if conn.execute('SELECT current_database()').fetchone()[0] != 'neondb':
            raise SafeError('Wrong database; review required')
        baseline = conn.execute('SELECT snapshot_month, source_sha256, source_count, qualified_count FROM ccod_import.refresh_runs ORDER BY snapshot_month DESC LIMIT 1').fetchone()
        if baseline != (BASELINE_MONTH, BASELINE_SHA256, 4485123, 15716):
            raise SafeError('November baseline missing or changed; review required')
        if tracking_counts(conn) != (1, 17122, 0):
            raise SafeError('Baseline tracking state unexpected; review required')
    metadata = requests.get(API_BASE + '/datasets/ccod', headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60))
    if metadata.status_code != 200:
        raise SafeError('CCOD dataset metadata request failed')
    month, resource = latest_full_resource(metadata.json())
    if month <= BASELINE_MONTH:
        print(json.dumps({'status': 'no_newer_release_available', 'target': importer.TARGET, 'baseline_month': BASELINE_MONTH.isoformat(), 'latest_available_month': month.isoformat(), 'latest_available_file': resource, 'database_changes': 'none', 'download_performed': False, 'schedule_status': 'disabled'}, indent=2))
        print('No CCOD release newer than the installed November baseline is available. No download or database change performed.')
        return
    download = requests.get(API_BASE + '/datasets/ccod/' + resource, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
    if download.status_code != 200:
        raise SafeError('Download-link request failed')
    payload = download.json()
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
            with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
                with conn.transaction():
                    conn.execute("SET LOCAL lock_timeout = '30s'")
                    conn.execute("SET LOCAL statement_timeout = '30min'")
                    importer.guard(conn)
                    if not conn.execute('SELECT pg_try_advisory_xact_lock(724310921)').fetchone()[0]:
                        raise SafeError('Another CCOD operation is running')
                    before_counts = importer.counts(conn)
                    before_tracking = tracking_counts(conn)
                    before_hashes = property_fingerprints(conn)
                    if database_bytes(conn) + 64 * 1024 ** 2 >= BUDGET:
                        raise SafeError('Insufficient storage headroom for refresh')
                    summary = refresh_archive(conn, archive, resource)
                    if summary.get('status') != 'applied_in_transaction':
                        raise SafeError('Unexpected coordinator result')
                    applied = conn.execute('SELECT snapshot_month, source_sha256, source_count, qualified_count FROM ccod_import.refresh_runs ORDER BY snapshot_month DESC LIMIT 1').fetchone()
                    if applied != (month, source_hash, summary['source_count'], summary['qualified_count']):
                        raise SafeError('Applied release record verification failed; review required')
                    if conn.execute('SELECT EXISTS (SELECT 1 FROM public.property_titles t LEFT JOIN ccod_import.refresh_membership m USING (title_number) WHERE m.title_number IS NULL)').fetchone()[0]:
                        raise SafeError('Refresh left a title without membership; review required')
                    with conn.transaction():
                        repeat = refresh_archive(conn, archive, resource)
                        if repeat.get('status') != 'already_applied' or repeat.get('persistent_changes') is not False:
                            raise SafeError('Repeat same-release no-op check failed')
                report = dict(status='newer_release_applied', target=importer.TARGET, release_month=month.isoformat(), resource=resource, source_sha256=source_hash, source_count=summary['source_count'], qualified_count=summary['qualified_count'], actions=summary.get('actions', {}), initial_counts=before_counts, initial_tracking_counts=before_tracking, final_counts=importer.counts(conn), final_tracking_counts=tracking_counts(conn), repeat_same_release=repeat['status'], schedule_status='disabled')
                print(json.dumps(report, indent=2))
                print('Newer CCOD release applied to the guarded test database. Monthly schedule remains disabled.')

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD newer-release refresh stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD newer-release refresh failed: ' + type(error).__name__ + '; database commit status is not confirmed by this message. Review before retrying; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
