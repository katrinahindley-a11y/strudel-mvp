import csv
import datetime as dt
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

TARGET = 'england-wales-property-test'
THRESHOLD = Decimal('5000000')
HEADERS = ['Title Number', 'Tenure', 'Property Address', 'District', 'County', 'Region', 'Postcode', 'Multiple Address Indicator', 'Price Paid']
for position in range(1, 5):
    HEADERS += [f'Proprietor Name ({position})', f'Company Registration No. ({position})', f'Proprietorship Category ({position})']
    HEADERS += [f'Proprietor ({position}) Address ({n})' for n in range(1, 4)]
HEADERS += ['Date Proprietor Added', 'Additional Proprietor Indicator']

class SafeError(ValueError):
    pass

def price(value):
    if not value:
        return None
    if not re.fullmatch(r'(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:[.][0-9]{1,2})?', value):
        raise SafeError('Invalid price format')
    try:
        result = Decimal(value.replace(',', ''))
        if not result.is_finite() or result < 0 or result >= Decimal('10000000000000000'):
            raise SafeError('Price outside supported range')
        return result
    except InvalidOperation:
        raise SafeError('Invalid price') from None

def records(archive, member):
    with archive.open(member) as binary:
        with io.TextIOWrapper(binary, encoding='utf-8-sig', newline='') as text:
            reader = csv.DictReader(text, strict=True)
            if reader.fieldnames != HEADERS:
                raise SafeError('CSV header differs from approved CCOD full format')
            for raw in reader:
                if None in raw or any(value is None for value in raw.values()):
                    raise SafeError('Malformed CSV row')
                row = {key: value.strip() for key, value in raw.items()}
                if not row['Title Number'] or not row['Tenure']:
                    raise SafeError('Missing title number or tenure')
                owners = []
                for position in range(1, 5):
                    name = row[f'Proprietor Name ({position})']
                    detail_keys = [f'Company Registration No. ({position})', f'Proprietorship Category ({position})'] + [f'Proprietor ({position}) Address ({n})' for n in range(1, 4)]
                    if not name:
                        if any(row[key] for key in detail_keys):
                            raise SafeError('Proprietor details supplied without a name')
                        continue
                    owners.append((name, row[f'Company Registration No. ({position})'] or None, row[f'Proprietorship Category ({position})'] or None, *(row[f'Proprietor ({position}) Address ({n})'] or None for n in range(1, 4))))
                if not owners:
                    raise SafeError('Title has no named proprietor')
                try:
                    added = dt.datetime.strptime(row['Date Proprietor Added'], '%d-%m-%Y').date() if row['Date Proprietor Added'] else None
                except ValueError:
                    raise SafeError('Invalid proprietor-added date') from None
                title = (row['Title Number'], row['Tenure'], *(row[key] or None for key in ['Property Address', 'District', 'County', 'Region', 'Postcode']), price(row['Price Paid']), added)
                yield title, owners, raw

def guard(conn):
    if conn.execute('SELECT target_name FROM ccod_import.target_guard WHERE id = 1').fetchall() != [(TARGET,)]:
        raise SafeError('Test database marker missing or incorrect')

def check_endpoint(database, expected_host):
    from psycopg.conninfo import conninfo_to_dict
    if not re.fullmatch(r'ep-[a-z0-9-]+[.][a-z0-9.-]+[.]neon[.]tech', expected_host):
        raise SafeError('Separately confirmed Neon test hostname required')
    options = conninfo_to_dict(database)
    if options.get('host') != expected_host or options.get('hostaddr') or options.get('service'):
        raise SafeError('Connection does not match approved test endpoint')
    if options.get('sslmode') not in ('require', 'verify-ca', 'verify-full'):
        raise SafeError('Encrypted database connection required')

def text_bytes(value):
    return 0 if value is None else len(str(value).encode('utf-8'))

def main():
    if os.environ.get('CCOD_MODE', 'validate') != 'validate':
        raise SafeError('Only validation mode is permitted')
    import psycopg
    import requests
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    check_endpoint(database, os.environ.get('CCOD_TEST_EXPECTED_HOST', ''))
    resource = os.environ.get('CCOD_RESOURCE', '')
    match = re.fullmatch(r'CCOD_FULL_(\d{4})_(\d{2})[.]zip', resource)
    if not match:
        raise SafeError('Invalid full resource filename')
    snapshot = dt.date(int(match[1]), int(match[2]), 1)
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not key:
        raise SafeError('Land Registry API key missing')
    endpoint = 'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + resource
    response = requests.get(endpoint, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
    if response.status_code != 200:
        raise SafeError('Download-link request failed')
    payload = response.json()
    url = payload.get('result', {}).get('download_url')
    if payload.get('success') is not True or not isinstance(url, str) or urlsplit(url).scheme != 'https' or urlsplit(url).hostname or urlsplit(url).username or urlsplit(url).password:
        raise SafeError('Invalid download-link response')
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
            members = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith('.csv')]
            if len(members) != 1 or members[0].file_size > 32 * 1024 ** 3:
                raise SafeError('Unexpected ZIP contents or CSV size')
            with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
                guard(conn)
                with conn.transaction():
                    conn.execute('CREATE TEMP TABLE high_value_titles (title_number text PRIMARY KEY) ON COMMIT DROP')
                    selected = 0
                    proprietors = 0
                    raw_bytes = 0
                    field_bytes = 0
                    blank_prices = 0
                    scanned = 0
                    with conn.cursor().copy('COPY high_value_titles (title_number) FROM STDIN') as copy:
                        for title, owners, raw in records(archive, members[0]):
                            scanned += 1
                            if title[7] is None:
                                blank_prices += 1
                                continue
                            if title[7] <= THRESHOLD:
                                continue
                            selected += 1
                            proprietors += len(owners)
                            raw_bytes += len(json.dumps(raw, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
                            field_bytes += sum(text_bytes(value) for value in title) + sum(sum(text_bytes(value) for value in owner) for owner in owners)
                            copy.write_row((title[0],))
                    existing_titles, existing_proprietors, existing_matches = conn.execute('SELECT (SELECT count(*) FROM public.property_titles), (SELECT count(*) FROM public.property_proprietors), (SELECT count(*) FROM public.property_charge_matches)').fetchone()
                    overlap = conn.execute('SELECT count(*) FROM high_value_titles h JOIN public.property_titles t USING (title_number)').fetchone()[0]
                    estimated_bytes = raw_bytes + field_bytes
                    result = {
                        'mode': 'validation_only',
                        'persistent_writes': False,
                        'source_file': resource,
                        'source_snapshot_month': snapshot.isoformat()[:7],
                        'threshold_gbp': 5000000,
                        'titles_scanned': scanned,
                        'high_value_titles': selected,
                        'high_value_proprietors': proprietors,
                        'titles_without_price': blank_prices,
                        'already_in_test_database': overlap,
                        'existing_titles': existing_titles,
                        'existing_proprietors': existing_proprietors,
                        'existing_charge_matches': existing_matches,
                        'estimated_source_bytes': estimated_bytes,
                        'estimated_storage_bytes_with_indexes': int(estimated_bytes * 1.5),
                        'estimated_storage_mib_with_indexes': round(estimated_bytes * 1.5 / (1024 * 1024), 1)
                    }
                    print(json.dumps(result, indent=2))
                    print('Validation complete. No persistent records were changed.')

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD £5m validation stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD £5m validation failed: ' + type(error).__name__ + '. Sensitive exception details suppressed.', file=sys.stderr)
        sys.exit(1)
