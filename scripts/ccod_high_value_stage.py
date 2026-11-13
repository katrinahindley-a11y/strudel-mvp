import datetime as dt
import json
import os
import sys
import tempfile
import zipfile
from decimal import Decimal
from urllib.parse import urlsplit
import psycopg
import requests
import ccod_import as importer
from ccod_import import SafeError
from ccod_footer_diagnostics import FooterReader

HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech'
RESOURCE = 'CCOD_FULL_2026_11.zip'
original_records = importer.records

def selected_records(archive, member, limit=None):
    if limit is not None:
        raise SafeError('Limited scan forbidden for national subset rehearsal')
    scanned = 0
    for title, owners, raw in original_records(archive, member):
        scanned += 1
        if title[9] is not None and title[9] > Decimal('5000000'):
            yield title, owners, raw
    if scanned != 4485123:
        raise SafeError('Full source count differs from validated November count')

def main():
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    importer.check_endpoint(database, HOST)
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        importer.guard(conn)
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
            importer.records = selected_records
            importer.csv.DictReader = FooterReader
            try:
                with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
                    importer.guard(conn)
                    before = importer.counts(conn)
                    report = None
                    with conn.transaction():
                        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                        result = importer.apply_archive(conn, archive, members[0], dt.date(2026, 11, 1), expected=15716, limit=None, write=False)
                        if result['source_proprietors'] != 16691:
                            raise SafeError('Proprietor count differs from validated November subset')
                        sizes = conn.execute("SELECT pg_total_relation_size('pg_temp.ccod_titles_stage'), pg_total_relation_size('pg_temp.ccod_owners_stage'), pg_database_size(current_database())").fetchone()
                        overlap = conn.execute('SELECT count(*) FROM ccod_titles_stage s JOIN public.property_titles t USING (title_number)').fetchone()[0]
                        if overlap != 29:
                            raise SafeError('Overlap count changed; review required before import')
                        importer.guard(conn)
                        report = dict(mode='staging_rehearsal_only', persistent_writes=False, titles=result['source_titles'], proprietors=result['source_proprietors'], overlapping_titles=overlap, stage_title_bytes=sizes[0], stage_proprietor_bytes=sizes[1], stage_total_bytes=sizes[0] + sizes[1], database_bytes_during_staging=sizes[2], size_note='Temporary tables include primary indexes but not all production secondary indexes. Refresh headroom and final import size require separate checks.', conflicts='none found by strict additive-import checks', initial_counts=before)
                        raise psycopg.Rollback()
                    after = importer.counts(conn)
                    if after != before:
                        raise SafeError('Database counts changed during rehearsal; review required')
                    if report is None:
                        raise SafeError('Rehearsal produced no report')
                    report['final_counts'] = after
                    report['temporary_staging_rolled_back'] = True
                    print(json.dumps(report, indent=2))
                    print('Staging rehearsal complete. No persistent property records changed.')
            finally:
                importer.records = original_records
                importer.csv.DictReader = FooterReader.__bases__[0]

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD staging stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD staging failed: ' + type(error).__name__ + '; active transaction rolled back, sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
