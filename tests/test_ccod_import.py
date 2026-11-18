import csv
import datetime as dt
import io
import os
from pathlib import Path
import sys
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ccod_import as ccod

MONTH = dt.date(2026, 11, 1)

def fixture(**changes):
    row = dict.fromkeys(ccod.HEADERS, '')
    row.update({'Title Number': 'TEST1', 'Tenure': 'Freehold', 'Property Address': '  Test address  ', 'Multiple Address Indicator': 'N', 'Additional Proprietor Indicator': 'N', 'Proprietor Name (1)': 'TEST OWNER', 'Company Registration No. (1)': '123', 'Date Proprietor Added': '01-11-2026'})
    row.update(changes)
    return row

def archive_for(rows, headers=None):
    text = io.StringIO(newline='')
    writer = csv.DictWriter(text, fieldnames=headers or ccod.HEADERS)
    writer.writeheader()
    writer.writerows(rows)
    binary = io.BytesIO()
    with zipfile.ZipFile(binary, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('fixture.csv', text.getvalue())
    binary.seek(0)
    return zipfile.ZipFile(binary)

class ParsingTests(unittest.TestCase):
    def parse(self, row):
        with archive_for([row]) as archive:
            return list(ccod.records(archive, 'fixture.csv'))[0]

    def test_raw_values_preserved(self):
        title, owners, raw = self.parse(fixture())
        self.assertEqual(title[2], 'Test address')
        self.assertEqual(raw['Property Address'], '  Test address  ')
        self.assertEqual(owners[0][4], '00000123')

    def test_price_boundaries(self):
        self.assertEqual(str(ccod.price('1,234.50')), '1234.50')
        self.assertEqual(str(ccod.price('9999999999999999.99')), '9999999999999999.99')
        self.assertIsNone(ccod.price(''))
        for value in ['NaN', 'Infinity', '-1', '1.001', '10000000000000000', '1,2', '1e3']:
            with self.subTest(value=value), self.assertRaises(ccod.SafeError):
                ccod.price(value)

    def test_bad_date(self):
        with self.assertRaises(ccod.SafeError):
            self.parse(fixture(**{'Date Proprietor Added': '31-02-2026'}))

    def test_bad_indicator(self):
        with self.assertRaises(ccod.SafeError):
            self.parse(fixture(**{'Multiple Address Indicator': 'maybe'}))

    def test_missing_owner(self):
        with self.assertRaises(ccod.SafeError):
            self.parse(fixture(**{'Proprietor Name (1)': '', 'Company Registration No. (1)': ''}))

    def test_orphan_owner_details(self):
        with self.assertRaises(ccod.SafeError):
            self.parse(fixture(**{'Proprietor (2) Address (1)': 'orphan'}))

    def test_missing_title(self):
        with self.assertRaises(ccod.SafeError):
            self.parse(fixture(**{'Title Number': ' '}))

    def test_header_rejected(self):
        headers = ccod.HEADERS[:-1]
        row = {key: value for key, value in fixture().items() if key in headers}
        with archive_for([row], headers) as archive, self.assertRaises(ccod.SafeError):
            list(ccod.records(archive, 'fixture.csv'))

    def test_limit(self):
        with archive_for([fixture(), fixture(**{'Title Number': 'TEST2'})]) as archive:
            self.assertEqual(len(list(ccod.records(archive, 'fixture.csv', 1))), 1)

    def test_candidate_is_not_verification(self):
        self.assertEqual(ccod.candidate('oc123456'), 'OC123456')
        self.assertIsNone(ccod.candidate('not-a-number'))

    def test_live_writes_disabled(self):
        with patch.dict(os.environ, {'CCOD_MODE': 'full'}), self.assertRaisesRegex(ccod.SafeError, 'disabled'):
            ccod.main()

@unittest.skipUnless(os.environ.get('CCOD_CI_DATABASE_URL'), 'Disposable PostgreSQL not configured')
class DatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        cls.conn = psycopg.connect(os.environ['CCOD_CI_DATABASE_URL'], autocommit=True)
        cls.conn.execute('CREATE TABLE companies (id UUID PRIMARY KEY); CREATE TABLE charges (id UUID PRIMARY KEY)')
        cls.conn.execute((Path(__file__).resolve().parents[1] / 'migrations/001_property_ownership.sql').read_text())
        cls.conn.execute('CREATE SCHEMA ccod_import; CREATE TABLE ccod_import.target_guard (id INTEGER PRIMARY KEY, target_name TEXT NOT NULL)')
        cls.conn.execute('INSERT INTO ccod_import.target_guard VALUES (1, %s)', (ccod.TARGET,))

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.conn.execute('TRUNCATE public.property_charge_matches, public.property_proprietors, public.property_titles, public.charges, public.companies CASCADE')
        self.conn.execute('UPDATE ccod_import.target_guard SET target_name = %s WHERE id = 1', (ccod.TARGET,))

    def load(self, rows=None, **options):
        with archive_for([fixture()] if rows is None else rows) as archive:
            return ccod.apply_archive(self.conn, archive, 'fixture.csv', MONTH, **options)

    def test_validation_has_no_persistent_writes(self):
        result = self.load()
        self.assertFalse(result['persistent_writes'])
        self.assertEqual(ccod.counts(self.conn), (0, 0, 0))

    def test_insert_and_repeat(self):
        self.assertEqual(self.load(write=True)['inserted_titles'], 1)
        result = self.load(write=True)
        self.assertEqual((result['inserted_titles'], result['inserted_proprietors']), (0, 0))
        self.assertEqual(ccod.counts(self.conn), (1, 1, 0))

    def test_title_conflict_rolls_back_all_rows(self):
        self.load(write=True)
        with self.assertRaises(ccod.SafeError):
            self.load([fixture(**{'Tenure': 'Leasehold'}), fixture(**{'Title Number': 'TEST2'})], write=True)
        self.assertEqual(ccod.counts(self.conn), (1, 1, 0))

    def test_changed_owner_rejected(self):
        self.load(write=True)
        with self.assertRaises(ccod.SafeError):
            self.load([fixture(**{'Proprietor Name (1)': 'DIFFERENT OWNER'})], write=True)
        self.assertEqual(self.conn.execute('SELECT proprietor_name FROM public.property_proprietors').fetchone()[0], 'TEST OWNER')

    def test_missing_existing_owner_rejected(self):
        row = fixture(**{'Proprietor Name (2)': 'SECOND OWNER'})
        self.load([row], write=True)
        with self.assertRaises(ccod.SafeError):
            self.load(write=True)
        self.assertEqual(ccod.counts(self.conn), (1, 2, 0))

    def test_new_owner_on_existing_title_rejected(self):
        self.load(write=True)
        with self.assertRaises(ccod.SafeError):
            self.load([fixture(**{'Proprietor Name (2)': 'SECOND OWNER'})], write=True)

    def test_duplicate_title_rejected(self):
        import psycopg
        with self.assertRaises(psycopg.errors.UniqueViolation):
            self.load([fixture(), fixture()], write=True)
        self.assertEqual(ccod.counts(self.conn), (0, 0, 0))

    def test_wrong_count_rolls_back(self):
        with self.assertRaises(ccod.SafeError):
            self.load(expected=2, write=True)
        self.assertEqual(ccod.counts(self.conn), (0, 0, 0))

    def test_guard_rejects_wrong_database(self):
        self.conn.execute("UPDATE ccod_import.target_guard SET target_name = 'production'")
        with self.assertRaises(ccod.SafeError):
            self.load(write=True)
        self.assertEqual(ccod.counts(self.conn), (0, 0, 0))

    def test_real_inserts_can_be_rolled_back(self):
        import psycopg
        with self.conn.transaction():
            self.load(write=True)
            self.assertEqual(ccod.counts(self.conn), (1, 1, 0))
            raise psycopg.Rollback()
        self.assertEqual(ccod.counts(self.conn), (0, 0, 0))

    def test_check_constraints_copied(self):
        import psycopg
        with self.conn.transaction():
            self.conn.execute('CREATE TEMP TABLE test_checks (LIKE public.property_titles INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP')
            with self.assertRaises(psycopg.errors.CheckViolation):
                with self.conn.transaction():
                    self.conn.execute("INSERT INTO test_checks (title_number, tenure, source_snapshot_month, raw_data) VALUES ('BAD', 'Freehold', '2026-11-02', '{}'::jsonb)")

    def test_foreign_key_on_staging(self):
        import psycopg
        with self.conn.transaction():
            self.conn.execute('CREATE TEMP TABLE test_parent (title_number TEXT PRIMARY KEY) ON COMMIT DROP')
            self.conn.execute('CREATE TEMP TABLE test_child (LIKE public.property_proprietors INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP')
            self.conn.execute('ALTER TABLE test_child ADD FOREIGN KEY (title_number) REFERENCES test_parent(title_number)')
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):
                with self.conn.transaction():
                    self.conn.execute("INSERT INTO test_child (title_number, proprietor_position, proprietor_name) VALUES ('MISSING', 1, 'TEST')")

    def test_charge_matches_unchanged(self):
        self.load(write=True)
        self.conn.execute("INSERT INTO charges VALUES ('00000000-0000-0000-0000-000000000001')")
        self.conn.execute("INSERT INTO property_charge_matches (title_number, charge_id, match_method, match_evidence) VALUES ('TEST1', '00000000-0000-0000-0000-000000000001', 'manual', '{}'::jsonb)")
        before = self.conn.execute('SELECT to_jsonb(p) FROM property_charge_matches p').fetchall()
        self.load(write=True)
        self.assertEqual(before, self.conn.execute('SELECT to_jsonb(p) FROM property_charge_matches p').fetchall())

    def test_endpoint_mismatch_rejected(self):
        with self.assertRaises(ccod.SafeError):
            ccod.check_endpoint('postgresql://localhost/test', 'ep-confirmed.us-east-2.aws.neon.tech')

if __name__ == '__main__':
    unittest.main()
