import datetime as dt
import json
import os
import sys
import tempfile
import zipfile
from urllib.parse import urlsplit
import psycopg
import requests
import ccod_import as importer
from ccod_import import SafeError
from ccod_footer_diagnostics import FooterReader
from ccod_high_value_stage import HOST, RESOURCE, selected_records

def storage_bytes(conn):
    return conn.execute('SELECT sum(pg_database_size(datname))::bigint FROM pg_database WHERE datallowconn').fetchone()[0]

def verify_contents(conn, stage, table, columns):
    fields = columns.split(',')
    target = ','.join('t.' + field for field in fields)
    query = f'WITH expected AS (SELECT {columns} FROM {stage}), actual AS (SELECT {target} FROM public.{table} t JOIN ccod_titles_stage s USING (title_number)) SELECT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))'
    if conn.execute(query).fetchone()[0]:
        raise SafeError('Inserted source contents differ; rolling back')

def main():
    if os.environ.get('CCOD_IMPORT_APPROVAL') != 'IMPORT_NOVEMBER_2026_OVER_5000000_TEST_ONLY':
        raise SafeError('Exact import approval missing')
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    importer.check_endpoint(database, HOST)
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        importer.guard(conn)
        if conn.execute('SELECT current_database()').fetchone()[0] != 'neondb':
            raise SafeError('Unexpected database name')
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
            original_records = importer.records
            original_reader = importer.csv.DictReader
            importer.records = selected_records
            importer.csv.DictReader = FooterReader
            try:
                with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
                    with conn.transaction():
                        conn.execute("SET LOCAL lock_timeout = '30s'")
                        conn.execute("SET LOCAL statement_timeout = '30min'")
                        importer.guard(conn)
                        conn.execute('LOCK TABLE public.property_titles, public.property_proprietors, public.property_charge_matches IN SHARE ROW EXCLUSIVE MODE')
                        before = importer.counts(conn)
                        if before != (1435, 1477, 0):
                            raise SafeError('Initial counts changed or import already ran; no writes performed')
                        staged = importer.apply_archive(conn, archive, members[0], dt.date(2026, 11, 1), expected=15716, limit=None, write=False)
                        if staged['source_proprietors'] != 16691:
                            raise SafeError('Unexpected proprietor source count')
                        overlap = conn.execute('SELECT count(*) FROM ccod_titles_stage s JOIN public.property_titles t USING (title_number)').fetchone()[0]
                        if overlap != 29:
                            raise SafeError('Unexpected title overlap')
                        stage_bytes = conn.execute("SELECT pg_total_relation_size('pg_temp.ccod_titles_stage') + pg_total_relation_size('pg_temp.ccod_owners_stage')").fetchone()[0]
                        if storage_bytes(conn) + 4 * stage_bytes >= 768 * 1024 ** 2:
                            raise SafeError('Conservative storage-headroom check failed')
                        expected_owners = conn.execute('SELECT count(*) FROM ccod_owners_stage s WHERE NOT EXISTS (SELECT 1 FROM public.property_proprietors p WHERE p.title_number = s.title_number AND p.proprietor_position = s.proprietor_position)').fetchone()[0]
                        added_titles = conn.execute(f'INSERT INTO public.property_titles ({importer.TITLE_COLUMNS}) SELECT {importer.TITLE_COLUMNS} FROM ccod_titles_stage s WHERE NOT EXISTS (SELECT 1 FROM public.property_titles t WHERE t.title_number = s.title_number)').rowcount
                        added_owners = conn.execute(f'INSERT INTO public.property_proprietors ({importer.OWNER_COLUMNS}) SELECT {importer.OWNER_COLUMNS} FROM ccod_owners_stage s WHERE NOT EXISTS (SELECT 1 FROM public.property_proprietors p WHERE p.title_number = s.title_number AND p.proprietor_position = s.proprietor_position)').rowcount
                        after = importer.counts(conn)
                        if added_titles != 15687 or added_owners != expected_owners or after != (17122, before[1] + expected_owners, before[2]):
                            raise SafeError('Final counts incorrect; rolling back')
                        verify_contents(conn, 'ccod_titles_stage', 'property_titles', importer.TITLE_COLUMNS)
                        verify_contents(conn, 'ccod_owners_stage', 'property_proprietors', importer.OWNER_COLUMNS)
                        if conn.execute('SELECT EXISTS (SELECT 1 FROM public.property_proprietors p LEFT JOIN public.property_titles t USING (title_number) WHERE t.title_number IS NULL)').fetchone()[0]:
                            raise SafeError('Orphan proprietors found; rolling back')
                        final_bytes = storage_bytes(conn)
                        if final_bytes + stage_bytes >= 768 * 1024 ** 2:
                            raise SafeError('Final storage-headroom check failed; rolling back')
                        importer.guard(conn)
                        report = dict(mode='permanent_test_import', target=importer.TARGET, source_file=RESOURCE, threshold_gbp=5000000, source_titles=15716, source_proprietors=16691, overlapping_titles=29, inserted_titles=added_titles, inserted_proprietors=added_owners, initial_counts=before, final_counts=after, stage_bytes=stage_bytes, connectable_databases_bytes_before_commit=final_bytes, contents_verified=True, charge_match_count_unchanged=True)
                    report['transaction_committed'] = True
                    print(json.dumps(report, indent=2))
                    print('Guarded test import committed. Production unchanged; monthly automation not enabled.')
            finally:
                importer.records = original_records
                importer.csv.DictReader = original_reader

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD import stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD import failed: ' + type(error).__name__ + '; check database state before retrying, sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
