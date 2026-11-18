import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tested' / 'scripts'))
import ccod_import as ccod

HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech'
RESOURCE = 'CCOD_FULL_2026_11.zip'
MONTH = dt.date(2026, 11, 1)

def main():
    import psycopg
    import requests
    if os.environ.get('CCOD_SAMPLE_CONFIRM') != ccod.TARGET:
        raise ccod.SafeError('Explicit test-target confirmation required')
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    ccod.check_endpoint(database, HOST)
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not key:
        raise ccod.SafeError('Land Registry API key missing')
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        ccod.guard(conn)
        endpoint = 'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + RESOURCE
        response = requests.get(endpoint, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
        if response.status_code != 200:
            raise ccod.SafeError('Download-link request failed')
        body = response.json()
        url = body.get('result', {}).get('download_url')
        if body.get('success') is not True or not isinstance(url, str) or urlsplit(url).scheme != 'https' or not urlsplit(url).hostname or urlsplit(url).username or urlsplit(url).password:
            raise ccod.SafeError('Invalid download URL')
        with tempfile.TemporaryFile() as downloaded:
            with requests.get(url, stream=True, timeout=(20, 120), allow_redirects=False) as response:
                if response.status_code != 200:
                    raise ccod.SafeError('Dataset download failed')
                size = 0
                for chunk in response.iter_content(1024 * 1024):
                    size += len(chunk)
                    if size > 4 * 1024 ** 3:
                        raise ccod.SafeError('ZIP exceeds safety limit')
                    downloaded.write(chunk)
            downloaded.seek(0)
            with zipfile.ZipFile(downloaded) as archive:
                members = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith('.csv')]
                if len(members) != 1 or members[0].file_size > 32 * 1024 ** 3:
                    raise ccod.SafeError('Unexpected ZIP contents or size')
                with conn.transaction():
                    ccod.guard(conn)
                    first = ccod.apply_archive(conn, archive, members[0], MONTH, expected=1000, limit=1000, write=True)
                    conn.execute('DROP TABLE pg_temp.ccod_owners_stage, pg_temp.ccod_titles_stage')
                    repeat = ccod.apply_archive(conn, archive, members[0], MONTH, expected=1000, limit=1000, write=True)
                    if repeat['inserted_titles'] != 0 or repeat['inserted_proprietors'] != 0 or first['final_counts'] != repeat['final_counts']:
                        raise ccod.SafeError('Repeat-run verification failed; entire sample transaction rolled back')
                    ccod.guard(conn)
                print(json.dumps({'committed': True, 'target': ccod.TARGET, 'resource': RESOURCE, 'first_pass': first, 'repeat_pass': repeat, 'charge_matches': 'unchanged'}))

if __name__ == '__main__':
    try:
        main()
    except ccod.SafeError as error:
        print('Sample stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Sample failed: ' + type(error).__name__ + '. Active sample transaction rolled back; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
