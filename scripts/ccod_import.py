import csv
import datetime as dt
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from decimal import Decimal
from urllib.parse import urlsplit

import psycopg
from psycopg.types.json import Jsonb
import requests

TARGET = 'england-wales-property-test'
TITLE_COLUMNS = 'title_number,tenure,property_address,district,county,region,postcode,multiple_address_indicator,additional_proprietor_indicator,price_paid,date_proprietor_added,source_dataset,source_snapshot_month,raw_data'
OWNER_COLUMNS = 'title_number,proprietor_position,proprietor_name,registration_number_raw,company_number_candidate,proprietorship_category,address_1,address_2,address_3'

def guard(conn):
    rows = conn.execute('SELECT target_name FROM ccod_import.target_guard WHERE id = 1').fetchall()
    if rows != [(TARGET,)]:
        raise ValueError('Test database guard missing or incorrect')

def flag(value):
    if value not in ('', 'Y', 'N'):
        raise ValueError('Invalid indicator')
    return None if not value else value == 'Y'

def candidate(value):
    value = value.upper().replace(' ', '')
    if re.fullmatch(r'[0-9]{1,8}', value):
        return value.zfill(8)
    if re.fullmatch(r'[A-Z]{2}[0-9]{6}', value):
        return value
    return None

def records(archive, member, limit):
    with archive.open(member) as binary:
        with io.TextIOWrapper(binary, encoding='utf-8-sig', newline='') as text:
            reader = csv.DictReader(text, strict=True)
            required = ['Title Number', 'Tenure', 'Property Address', 'District', 'County', 'Region', 'Postcode', 'Multiple Address Indicator', 'Additional Proprietor Indicator', 'Price Paid', 'Date Proprietor Added']
            for position in range(1, 5):
                required += [f'Proprietor Name ({position})', f'Company Registration No. ({position})', f'Proprietorship Category ({position})']
                required += [f'Proprietor ({position}) Address ({n})' for n in range(1, 4)]
            if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames) or not set(required).issubset(reader.fieldnames):
                raise ValueError('CSV header does not match CCOD full format')
            for number, row in enumerate(reader, 1):
                if limit and number > limit:
                    break
                if None in row or any(value is None for value in row.values()):
                    raise ValueError('Malformed CSV row')
                if not row['Title Number'].strip() or not row['Tenure'].strip():
                    raise ValueError('Missing title number or tenure')
                yield {key: value.strip() for key, value in row.items()}

def main():
    mode = os.environ.get('CCOD_MODE', 'validate')
    resource = os.environ.get('CCOD_RESOURCE', '')
    match = re.fullmatch(r'CCOD_FULL_(\d{4})_(\d{2})\.zip', resource)
    if mode not in ('validate', 'sample', 'full') or not match:
        raise ValueError('Invalid mode or full resource filename')
    snapshot = dt.date(int(match[1]), int(match[2]), 1)
    expected = int(os.environ.get('CCOD_EXPECTED_TITLES', '0'))
    if mode == 'full' and expected <= 0:
        raise ValueError('Full import requires the exact expected source title count')
    if mode != 'validate' and os.environ.get('CCOD_CONFIRM_TARGET') != TARGET:
        raise ValueError('Explicit test target confirmation is required')
    database = os.environ.get('CCOD_TEST_DATABASE_URL', '')
    key = os.environ.get('LAND_REGISTRY_API_KEY', '').strip()
    if not database.startswith(('postgresql://', 'postgres://')) or not key:
        raise ValueError('Required secrets missing or invalid')
    with psycopg.connect(database, autocommit=True, connect_timeout=20) as conn:
        guard(conn)
        initial = conn.execute('SELECT (SELECT count(*) FROM public.property_titles), (SELECT count(*) FROM public.property_proprietors), (SELECT count(*) FROM public.property_charge_matches)').fetchone()
        print(json.dumps({'mode': mode, 'target': TARGET, 'initial_counts': initial}), flush=True)
        endpoint = 'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/' + resource
        response = requests.get(endpoint, headers={'Authorization': key, 'Accept': 'application/json'}, timeout=(20, 60), allow_redirects=False)
        if response.status_code != 200:
            raise ValueError('Land Registry download-link request failed')
        payload = response.json()
        url = payload.get('result', {}).get('download_url')
        if payload.get('success') is not True or not isinstance(url, str):
            raise ValueError('Land Registry returned no download URL')
        if urlsplit(url).scheme != 'https' or urlsplit(url).username or urlsplit(url).password:
            raise ValueError('Invalid download URL')
        limit = 1000 if mode in ('validate', 'sample') else None
        with tempfile.TemporaryFile() as downloaded:
            with requests.get(url, stream=True, timeout=(20, 120)) as stream:
                if stream.status_code != 200 or urlsplit(stream.url).scheme != 'https':
                    raise ValueError('Dataset download failed')
                for chunk in stream.iter_content(1024 * 1024):
                    downloaded.write(chunk)
            downloaded.seek(0)
            with zipfile.ZipFile(downloaded) as archive:
                members = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith('.csv')]
                if len(members) != 1:
                    raise ValueError('Expected exactly one CSV in ZIP')
                with conn.transaction():
                    guard(conn)
                    conn.execute("SET LOCAL lock_timeout = '30s'")
                    conn.execute('SELECT pg_advisory_xact_lock(724310921)')
                    conn.execute('CREATE TEMP TABLE ccod_titles_stage (LIKE public.property_titles INCLUDING DEFAULTS) ON COMMIT DROP')
                    conn.execute('CREATE TEMP TABLE ccod_owners_stage (LIKE public.property_proprietors INCLUDING DEFAULTS) ON COMMIT DROP')
                    title_count = 0
                    with conn.cursor().copy(f'COPY ccod_titles_stage ({TITLE_COLUMNS}) FROM STDIN') as copy:
                        for row in records(archive, members[0], limit):
                            price = Decimal(row['Price Paid'].replace(',', '')) if row['Price Paid'] else None
                            if price is not None and (not price.is_finite() or price < 0 or price != price.quantize(Decimal('0.01'))):
                                raise ValueError('Invalid price')
                            added = dt.datetime.strptime(row['Date Proprietor Added'], '%d-%m-%Y').date() if row['Date Proprietor Added'] else None
                            copy.write_row((row['Title Number'], row['Tenure'], row['Property Address'] or None, row['District'] or None, row['County'] or None, row['Region'] or None, row['Postcode'] or None, flag(row['Multiple Address Indicator']), flag(row['Additional Proprietor Indicator']), price, added, 'CCOD', snapshot, Jsonb(row)))
                            title_count += 1
                            if title_count % 100000 == 0:
                                print(json.dumps({'staged_titles': title_count}), flush=True)
                    if not title_count or (mode == 'full' and title_count != expected):
                        raise ValueError('Source title count is empty or differs from expected count')
                    conn.execute('CREATE UNIQUE INDEX ON ccod_titles_stage (title_number)')
                    owner_count = 0
                    with conn.cursor().copy(f'COPY ccod_owners_stage ({OWNER_COLUMNS}) FROM STDIN') as copy:
                        for row in records(archive, members[0], limit):
                            for position in range(1, 5):
                                name = row[f'Proprietor Name ({position})']
                                if not name:
                                    continue
                                registration = row[f'Company Registration No. ({position})']
                                copy.write_row((row['Title Number'], position, name, registration or None, candidate(registration), row[f'Proprietorship Category ({position})'] or None, *(row[f'Proprietor ({position}) Address ({n})'] or None for n in range(1, 4))))
                                owner_count += 1
                    conn.execute('CREATE UNIQUE INDEX ON ccod_owners_stage (title_number, proprietor_position)')
                    print(json.dumps({'validated_titles': title_count, 'validated_proprietors': owner_count, 'validation_scope': 'first 1000 titles only' if limit else 'entire file'}), flush=True)
                    if mode == 'validate':
                        print('Validation complete. No persistent database records changed. Full ZIP downloaded; only first 1000 titles validated.')
                        return
                    guard(conn)
                    conn.execute('LOCK TABLE public.property_titles, public.property_proprietors, public.property_charge_matches IN SHARE ROW EXCLUSIVE MODE')
                    before = conn.execute('SELECT (SELECT count(*) FROM public.property_titles), (SELECT count(*) FROM public.property_proprietors), (SELECT count(*) FROM public.property_charge_matches)').fetchone()
                    added_titles = conn.execute(f'INSERT INTO public.property_titles ({TITLE_COLUMNS}) SELECT {TITLE_COLUMNS} FROM ccod_titles_stage ON CONFLICT (title_number) DO NOTHING').rowcount
                    added_owners = conn.execute(f'INSERT INTO public.property_proprietors ({OWNER_COLUMNS}) SELECT {OWNER_COLUMNS} FROM ccod_owners_stage s WHERE NOT EXISTS (SELECT 1 FROM public.property_titles t WHERE t.title_number = s.title_number AND NOT EXISTS (SELECT 1 FROM ccod_titles_stage v WHERE v.title_number = t.title_number)) ON CONFLICT (title_number, proprietor_position) DO NOTHING').rowcount
                    missing = conn.execute('SELECT count(*) FROM ccod_titles_stage s LEFT JOIN public.property_titles t USING (title_number) WHERE t.title_number IS NULL').fetchone()[0]
                    missing_owners = conn.execute('SELECT count(*) FROM ccod_owners_stage s LEFT JOIN public.property_proprietors p USING (title_number, proprietor_position) WHERE p.title_number IS NULL').fetchone()[0]
                    after = conn.execute('SELECT (SELECT count(*) FROM public.property_titles), (SELECT count(*) FROM public.property_proprietors), (SELECT count(*) FROM public.property_charge_matches)').fetchone()
                    if missing or missing_owners or after != (before[0] + added_titles, before[1] + added_owners, before[2]):
                        raise ValueError('Post-import verification failed; rolling back')
                print(json.dumps({'committed': True, 'inserted_titles': added_titles, 'inserted_proprietors': added_owners, 'final_counts': after, 'existing_records': 'preserved, not refreshed', 'charge_matches': 'unchanged'}), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('CCOD job failed (' + type(error).__name__ + '). Any active import transaction was rolled back. Connection strings and download URLs are not logged.', file=sys.stderr)
        sys.exit(1)
