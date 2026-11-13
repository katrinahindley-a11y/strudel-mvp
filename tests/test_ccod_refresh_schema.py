import os
from pathlib import Path
import unittest
import psycopg
from psycopg.conninfo import conninfo_to_dict
from test_ccod_import import archive_for, fixture, MONTH
import ccod_import as ccod

ROOT = Path(__file__).resolve().parents[1]

class RefreshSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url = os.environ.get('CCOD_REFRESH_CI_URL', '')
        options = conninfo_to_dict(url)
        if options.get('host') != 'localhost' or options.get('dbname') != 'ccod_refresh_ci':
            raise RuntimeError('Disposable local test database required')
        cls.conn = psycopg.connect(url, autocommit=True)
        cls.conn.execute('CREATE TABLE companies (id uuid PRIMARY KEY); CREATE TABLE charges (id uuid PRIMARY KEY)')
        cls.conn.execute((ROOT / 'migrations/001_property_ownership.sql').read_text())
        cls.conn.execute('CREATE SCHEMA ccod_import; CREATE TABLE ccod_import.target_guard (id integer PRIMARY KEY, target_name text NOT NULL)')
        cls.conn.execute('INSERT INTO ccod_import.target_guard VALUES (1, %s)', (ccod.TARGET,))
        cls.conn.execute((ROOT / 'migrations/002_ccod_refresh_state.sql').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.tx = self.conn.transaction(force_rollback=True)
        self.tx.__enter__()
        with archive_for([fixture(**{'Price Paid': '6000000'})]) as archive:
            ccod.apply_archive(self.conn, archive, 'fixture.csv', MONTH, write=True)

    def tearDown(self):
        self.tx.__exit__(None, None, None)

    def receipt(self):
        self.conn.execute("INSERT INTO ccod_import.refresh_runs (snapshot_month, resource_name, source_sha256, source_count, qualified_count, summary) VALUES ('2026-11-01', 'CCOD_FULL_2026_11.zip', %s, 1, 1, '{}'::jsonb)", ('a' * 64,))

    def membership(self, managed=True, sample=False):
        self.conn.execute("INSERT INTO ccod_import.refresh_membership (title_number, managed_high_value, retain_sample, last_checked_month, last_seen_month) VALUES ('TEST1', %s, %s, '2026-11-01', '2026-11-01')", (managed, sample))

    def archive_history(self):
        self.conn.execute("INSERT INTO ccod_import.property_history (snapshot_month, title_number, event_kind, title_before, title_after, owners_before, owners_after, charge_reviews_before) SELECT '2026-11-01', t.title_number, 'baseline', to_jsonb(t), to_jsonb(t), (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.proprietor_position), '[]'::jsonb) FROM public.property_proprietors p WHERE p.title_number = t.title_number), '[]'::jsonb, (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM public.property_charge_matches m WHERE m.title_number = t.title_number) FROM public.property_titles t WHERE t.title_number = 'TEST1'")

    def test_membership_does_not_change_properties(self):
        before = self.conn.execute('SELECT to_jsonb(p) FROM property_proprietors p').fetchall()
        self.receipt()
        self.membership()
        self.conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
        self.assertEqual(before, self.conn.execute('SELECT to_jsonb(p) FROM property_proprietors p').fetchall())

    def test_sample_and_managed_overlap_supported(self):
        self.receipt()
        self.membership(True, True)
        self.assertEqual(self.conn.execute('SELECT managed_high_value, retain_sample FROM ccod_import.refresh_membership').fetchone(), (True, True))

    def test_retirement_preserves_title_and_owners(self):
        self.receipt()
        self.membership()
        self.conn.execute("UPDATE ccod_import.refresh_membership SET active = false, retirement_reason = 'price_missing'")
        self.assertEqual(ccod.counts(self.conn), (1, 1, 0))

    def test_membership_blocks_cascading_title_deletion(self):
        self.receipt()
        self.membership()
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with self.conn.transaction():
                self.conn.execute("DELETE FROM property_titles WHERE title_number = 'TEST1'")
        self.assertEqual(ccod.counts(self.conn), (1, 1, 0))

    def test_history_preserves_matching_evidence_and_charge_review(self):
        self.receipt()
        self.conn.execute("UPDATE property_proprietors SET company_match_status = 'needs_review', company_match_evidence = '{\"note\":\"keep matching evidence\"}'::jsonb")
        self.conn.execute("INSERT INTO charges VALUES ('00000000-0000-0000-0000-000000000001')")
        self.conn.execute("INSERT INTO property_charge_matches (title_number, charge_id, match_method, match_evidence, review_status, reviewer_note) VALUES ('TEST1', '00000000-0000-0000-0000-000000000001', 'manual', '{}'::jsonb, 'confirmed', 'keep review')")
        self.archive_history()
        owners, reviews = self.conn.execute('SELECT owners_before, charge_reviews_before FROM ccod_import.property_history').fetchone()
        self.assertEqual(owners[0]['company_match_evidence']['note'], 'keep matching evidence')
        self.assertEqual(reviews[0]['reviewer_note'], 'keep review')
        self.assertEqual(ccod.counts(self.conn), (1, 1, 1))

    def test_duplicate_snapshot_receipt_rejected(self):
        self.receipt()
        with self.assertRaises(psycopg.errors.UniqueViolation):
            with self.conn.transaction():
                self.receipt()

    def test_history_requires_successful_snapshot_receipt(self):
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with self.conn.transaction():
                self.archive_history()
                self.conn.execute('SET CONSTRAINTS ALL IMMEDIATE')

    def test_history_prevents_duplicate_event_per_title_snapshot(self):
        self.receipt()
        self.archive_history()
        with self.assertRaises(psycopg.errors.UniqueViolation):
            with self.conn.transaction():
                self.archive_history()

    def test_failed_transaction_rolls_back_tracking_and_history(self):
        with self.conn.transaction():
            self.receipt()
            self.membership()
            self.archive_history()
            raise psycopg.Rollback()
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0], 0)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.property_history').fetchone()[0], 0)

    def test_invalid_retirement_state_rejected(self):
        self.receipt()
        self.membership()
        with self.assertRaises(psycopg.errors.CheckViolation):
            with self.conn.transaction():
                self.conn.execute('UPDATE ccod_import.refresh_membership SET active = false')

if __name__ == '__main__':
    unittest.main()
