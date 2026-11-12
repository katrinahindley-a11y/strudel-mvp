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
TITLE_COLUMNS = 'title_number,tenure,property_address,district,county,region,postcode,multiple_address_indicator,additional_proprietor_indicator,price_paid,date_proprietor_added,source_dataset,source_snapshot_month,raw_data'
OWNER_COLUMNS = 'title_number,proprietor_position,proprietor_name,registration_number_raw,company_number_candidate,proprietorship_category,address_1,address_2,address_3'
HEADERS = ['Title Number', 'Tenure', 'Property Address', 'District', 'County', 'Region', 'Postcode', 'Multiple Address Indicator', 'Price Paid']
for position in range(1, 5):
    HEADERS += [f'Proprietor Name ({position})', f'Company Registration No. ({position})', f'Proprietorship Category ({position})']
    HEADERS += [f'Proprietor ({position}) Address ({n})' for n in range(1, 4)]
HEADERS += ['Date Proprietor Added', 'Additional Proprietor Indicator']

class SafeError(ValueError):
    pass

def flag(value):
    if value not in ('', 'Y', 'N'):
        raise SafeError('Invalid Y/N indicator')
    return None if not value else value == 'Y'

def price(value):
    if not value:
        return None
    if not re.fullmatch(r'(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:[.][0-9]{1,2})?', value):
        raise SafeError('Invalid price format')
    try:
        result = Decimal(value.replace(',', ''))
        if not result.is_finite() or result < 0 or result >= Decimal('10000000000000000'):
            raise SafeError('Price outside NUMERIC(18,2) range')
        return result
    except InvalidOperation:
        raise SafeError('Invalid price') from None

def candidate(value):
    value = value.upper().replace(' ', '')
    if re.fullmatch(r'[0-9]{1,8}', value):
        return value.zfill(8)
    if re.fullmatch(r'[A-Z]{2}[0-9]{6}', value):
        return value
    return None

def records(archive, member, limit=None):
    with archive.open(member) as binary:
        with io.TextIOWrapper(binary, encoding='utf-8-sig', newline='') as text:
            reader = csv.DictReader(text, strict=True)
            if reader.fieldnames != HEADERS:
                raise SafeError('CSV header differs from approved CCOD full format')
            for number, raw in enumerate(reader, 1):
                if limit and number > limit:
                    break
                if None in raw or any(value is None for value in raw.values()):
                    raise SafeError('Malformed CSV row')
                row = {key: value.strip() for key, value in raw.items()}
                if not row['Title Number'] or not row['Tenure']:
                    raise SafeError('Missing title number or tenure')
                owners = []
                for p in range(1, 5):
                    name = row[f'Proprietor Name ({p})']
                    detail_keys = [f'Company Registration No. ({p})', f'Proprietorship Category ({p})'] + [f'Proprietor ({p}) Address ({n})' for n in range(1, 4)]
                    if not name:
                        if any(row[key] for key in detail_keys):
                            raise SafeError('Proprietor details supplied without a name')
                        continue
                    registration = row[f'Company Registration No. ({p})']
                    owners.append((row['Title Number'], p, name, registration or None, candidate(registration), row[f'Proprietorship Category ({p})'] or None, *(row[f'Proprietor ({p}) Address ({n})'] or None for n in range(1, 4))))
                if not owners:
                    raise SafeError('Title has no named proprietor')
                try:
                    added = dt.datetime.strptime(row['Date Proprietor Added'], '%d-%m-%Y').date() if row['Date Proprietor Added'] else None
                except ValueError:
                    raise SafeError('Invalid proprietor-added date') from None
                title = (row['Title Number'], row['Tenure'], *(row[key] or None for key in ['Property Address', 'District', 'County', 'Region', 'Postcode']), flag(row['Multiple Address Indicator']), flag(row['Additional Proprietor Indicator']), price(row['Price Paid']), added)
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

def counts(conn):
    return conn.execute('SELECT (SELECT count(*) FROM public.property_titles), (SELECT count(*) FROM public.property_proprietors), (SELECT count(*) FROM public.property_charge_matches)').fetchone()

def apply_archive(conn, archive, member, snapshot, expected=0, limit=None, write=False):
    from psycopg.types.json import Jsonb
    if snapshot.day != 1 or expected < 0:
        raise SafeError('Invalid snapshot date or expected count')
    with conn.transaction():
        guard(conn)
        conn.execute("SET LOCAL lock_timeout = '30s'")
        conn.execute("SET LOCAL statement_timeout = '30min'")
        if not conn.execute('SELECT pg_try_advisory_xact_lock(724310921)').fetchone()[0]:
            raise SafeError('Another CCOD import is running')
        for table, stage in [('property_titles', 'ccod_titles_stage'), ('property_proprietors', 'ccod_owners_stage')]:
            conn.execute(f'CREATE TEMP TABLE {stage} (LIKE public.{table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP')
        title_count = 0
        with conn.cursor().copy(f'COPY ccod_titles_stage ({TITLE_COLUMNS}) FROM STDIN') as copy:
            for title, owners, raw in records(archive, member, limit):
                copy.write_row((*title, 'CCOD', snapshot, Jsonb(raw)))
                title_count += 1
        if not title_count or (expected and title_count != expected):
            raise SafeError('Source title count differs from expected count or is empty')
        conn.execute('ALTER TABLE ccod_titles_stage ADD PRIMARY KEY (title_number)')
        owner_count = 0
        with conn.cursor().copy(f'COPY ccod_owners_stage ({OWNER_COLUMNS}) FROM STDIN') as copy:
            for title, owners, raw in records(archive, member, limit):
                for owner in owners:
                    copy.write_row(owner)
                    owner_count += 1
        conn.execute('ALTER TABLE ccod_owners_stage ADD PRIMARY KEY (title_number, proprietor_position)')
        conn.execute('ALTER TABLE ccod_owners_stage ADD FOREIGN KEY (title_number) REFERENCES ccod_titles_stage(title_number)')
        conn.execute('ANALYZE ccod_titles_stage')
        conn.execute('ANALYZE ccod_owners_stage')
        if write:
            conn.execute('LOCK TABLE public.property_titles, public.property_proprietors, public.property_charge_matches IN SHARE ROW EXCLUSIVE MODE')
        guard(conn)
        title_fields = TITLE_COLUMNS.split(',')
        title_diff = ' OR '.join(f't.{field} IS DISTINCT FROM s.{field}' for field in title_fields)
        if conn.execute(f'SELECT EXISTS (SELECT 1 FROM ccod_titles_stage s JOIN public.property_titles t USING (title_number) WHERE {title_diff})').fetchone()[0]:
            raise SafeError('Existing title data differs; additive import stopped')
        owner_fields = ','.join('p.' + field for field in OWNER_COLUMNS.split(','))
        stage_owner_fields = ','.join('s.' + field for field in OWNER_COLUMNS.split(','))
        owner_diff = f'WITH old_owners AS (SELECT {owner_fields} FROM public.property_proprietors p JOIN ccod_titles_stage t USING (title_number)), new_owners AS (SELECT {stage_owner_fields} FROM ccod_owners_stage s JOIN public.property_titles t USING (title_number)) SELECT EXISTS ((SELECT * FROM old_owners EXCEPT SELECT * FROM new_owners) UNION ALL (SELECT * FROM new_owners EXCEPT SELECT * FROM old_owners))'
        if conn.execute(owner_diff).fetchone()[0]:
            raise SafeError('Existing proprietor set differs; additive import stopped')
        before = counts(conn)
        result = {'source_titles': title_count, 'source_proprietors': owner_count, 'scope': 'limited' if limit else 'whole file', 'persistent_writes': write}
        if write:
            added_titles = conn.execute(f'INSERT INTO public.property_titles ({TITLE_COLUMNS}) SELECT {TITLE_COLUMNS} FROM ccod_titles_stage WHERE true ON CONFLICT (title_number) DO NOTHING').rowcount
            added_owners = conn.execute(f'INSERT INTO public.property_proprietors ({OWNER_COLUMNS}) SELECT {OWNER_COLUMNS} FROM ccod_owners_stage WHERE true ON CONFLICT (title_number, proprietor_position) DO NOTHING').rowcount
            after = counts(conn)
            if after != (before[0] + added_titles, before[1] + added_owners, before[2]):
                raise SafeError('Final counts incorrect; rolling back')
            if conn.execute(f'SELECT EXISTS (SELECT 1 FROM ccod_titles_stage s JOIN public.property_titles t USING (title_number) WHERE {title_diff})').fetchone()[0] or conn.execute(owner_diff).fetchone()[0]:
                raise SafeError('Inserted contents differ from source; rolling back')
            result.update(inserted_titles=added_titles, inserted_proprietors=added_owners, final_counts=after)
        else:
            result['initial_counts'] = before
    return result

def main():
    if os.environ.get('CCOD_MODE', 'validate') != 'validate':
        raise SafeError('Live write modes disabled pending integration tests and separate approval')
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
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        guard(conn)
        endpoint = 'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + resource
        response = requests.get(endpoint, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
        if response.status_code != 200:
            raise SafeError('Download-link request failed')
        payload = response.json()
        url = payload.get('result', {}).get('download_url')
        if payload.get('success') is not True or not isinstance(url, str) or urlsplit(url).scheme != 'https' or not urlsplit(url).hostname or urlsplit(url).username or urlsplit(url).password:
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
                print(json.dumps(apply_archive(conn, archive, members[0], snapshot, limit=1000)))
                print('Full ZIP downloaded; first 1000 titles checked. No persistent records changed.')

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD failed: ' + type(error).__name__ + '. Active transaction rolled back; sensitive exception details suppressed.', file=sys.stderr)
        sys.exit(1)
