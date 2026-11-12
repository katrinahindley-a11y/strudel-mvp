import json
import os
import sys
import tempfile
import zipfile
from decimal import Decimal
from urllib.parse import urlsplit

import psycopg
import requests
from ccod_import import SafeError, check_endpoint, guard, counts, records

HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech'
RESOURCE = 'CCOD_FULL_2026_11.zip'

def main():
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    check_endpoint(database, HOST)
    with psycopg.connect(database, connect_timeout=20) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        conn.execute("SET LOCAL statement_timeout = '60s'")
        guard(conn)
        before = counts(conn)
        existing = {r[0] for r in conn.execute('SELECT title_number FROM public.property_titles')}
        db_bytes = conn.execute('SELECT pg_database_size(current_database())').fetchone()[0]
        table_bytes = conn.execute("SELECT pg_total_relation_size('public.property_titles'), pg_total_relation_size('public.property_proprietors')").fetchone()
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not key:
        raise SafeError('Land Registry API key missing')
    endpoint = 'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + RESOURCE
    response = requests.get(endpoint, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
    if response.status_code != 200:
        raise SafeError('Download-link request failed')
    payload = response.json()
    url = payload.get('result', {}).get('download_url')
    if payload.get('success') is not True or not isinstance(url, str):
        raise SafeError('Invalid download-link response')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise SafeError('Invalid download-link URL')
    scanned = selected = owners_count = missing = overlap = raw_bytes = 0
    seen = set()
    with tempfile.TemporaryFile() as downloaded:
        with requests.get(url, stream=True, timeout=(20, 120), allow_redirects=False) as stream:
            if stream.status_code != 200:
                raise SafeError('Dataset download failed')
            size = 0
            for chunk in stream.iter_content(1024 * 1024):
                size += len(chunk)
                if size > 4 * 1024 ** 3:
                    raise SafeError('ZIP exceeds 4 GiB safety limit')
                downloaded.write(chunk)
        downloaded.seek(0)
        with zipfile.ZipFile(downloaded) as archive:
            members = [m for m in archive.infolist() if not m.is_dir() and m.filename.lower().endswith('.csv')]
            if len(members) != 1 or members[0].file_size > 32 * 1024 ** 3:
                raise SafeError('Unexpected ZIP contents or CSV size')
            for title, owners, raw in records(archive, members[0]):
                scanned += 1
                if title[9] is None:
                    missing += 1
                elif title[9] > Decimal('5000000'):
                    if title[0] in seen:
                        raise SafeError('Duplicate qualifying title')
                    seen.add(title[0])
                    selected += 1
                    owners_count += len(owners)
                    overlap += int(title[0] in existing)
                    raw_bytes += len(json.dumps(raw, ensure_ascii=False).encode('utf-8'))
                if scanned % 250000 == 0:
                    print(json.dumps({'titles_scanned_so_far': scanned}), flush=True)
    if not scanned:
        raise SafeError('Source contains no titles')
    projected = None
    if before[0] and before[1]:
        projected = round(selected * table_bytes[0] / before[0] + owners_count * table_bytes[1] / before[1])
    result = dict(mode='validation_only', persistent_writes=False, source_file=RESOURCE, threshold_gbp=5000000, comparison='strictly greater than', titles_scanned=scanned, high_value_titles=selected, high_value_proprietors=owners_count, titles_without_price=missing, already_in_test_database=overlap, existing_counts=before, current_database_bytes=db_bytes, selected_raw_json_bytes=raw_bytes, preliminary_subset_bytes_using_existing_table_averages=projected, storage_warning='Extrapolation only: excludes staging, refresh headroom and differing row sizes; not proof of capacity.')
    print(json.dumps(result, indent=2))
    print('Validation complete. No persistent records were changed.')

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD validation stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD validation failed: ' + type(error).__name__ + '; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
