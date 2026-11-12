import datetime as dt
import unittest
import psycopg
import test_ccod_refresh_schema as schema
from test_ccod_import import archive_for, fixture
import ccod_import as ccod
from ccod_refresh_update import apply_title, capture

DEC = dt.date(2026, 12, 1)
JAN = dt.date(2027, 1, 1)

class RefreshUpdateTests(unittest.TestCase):
    receipt = schema.RefreshSchemaTests.receipt
    membership = schema.RefreshSchemaTests.membership

    @classmethod
    def setUpClass(cls):
        schema.RefreshSchemaTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        schema.RefreshSchemaTests.setUp(self)
        self.receipt()
        self.membership()

    def tearDown(self):
        schema.RefreshSchemaTests.tearDown(self)

    def parsed(self, **changes):
        row = fixture(**{'Price Paid': '6000000'})
        row.update(changes)
        with archive_for([row]) as archive:
            return list(ccod.records(archive, 'fixture.csv'))[0]

    def pending_receipt(self, month=DEC):
        self.conn.execute('INSERT INTO ccod_import.refresh_runs (snapshot_month, resource_name, source_sha256, source_count, qualified_count, summary) VALUES (%s,%s,%s,10,1,%s::jsonb)', (month, month.strftime('CCOD_FULL_%Y_%m.zip'), 'b' * 64, '{}'))

    def test_property_details_update_and_history(self):
        self.pending_receipt()
        result = apply_title(self.conn, DEC, 'TEST1', self.parsed(**{'Property Address': 'New address'}), True)
        self.assertEqual(result['action'], 'changed')
        old, new = self.conn.execute('SELECT title_before, title_after FROM ccod_import.property_history').fetchone()
        self.assertEqual(old['property_address'], 'Test address')
        self.assertEqual(new['property_address'], 'New address')

    def test_replacement_owner_does_not_inherit_match(self):
        self.pending_receipt()
        self.conn.execute("UPDATE property_proprietors SET company_match_status = 'needs_review', company_match_evidence = '{\"keep\":true}'::jsonb")
        apply_title(self.conn, DEC, 'TEST1', self.parsed(**{'Proprietor Name (1)': 'NEW OWNER'}), True)
        self.assertEqual(self.conn.execute('SELECT company_match_status, company_match_evidence FROM property_proprietors').fetchone(), ('unmatched', None))
        saved = self.conn.execute('SELECT owners_before FROM ccod_import.property_history').fetchone()[0]
        self.assertTrue(saved[0]['company_match_evidence']['keep'])

    def test_reordered_owners_keep_matching_evidence(self):
        self.pending_receipt()
        self.conn.execute("UPDATE property_proprietors SET company_match_status = 'needs_review', company_match_evidence = '{\"owner\":\"A\"}'::jsonb")
        self.conn.execute("INSERT INTO property_proprietors (title_number, proprietor_position, proprietor_name) VALUES ('TEST1', 2, 'SECOND OWNER')")
        row = self.parsed(**{'Proprietor Name (1)': 'SECOND OWNER', 'Company Registration No. (1)': '', 'Proprietor Name (2)': 'TEST OWNER', 'Company Registration No. (2)': '123'})
        apply_title(self.conn, DEC, 'TEST1', row, True)
        self.assertEqual(self.conn.execute('SELECT company_match_evidence FROM property_proprietors WHERE proprietor_position = 2').fetchone()[0], {'owner': 'A'})

    def test_retirement_preserves_charge_reviews(self):
        self.pending_receipt()
        self.conn.execute("INSERT INTO charges VALUES ('00000000-0000-0000-0000-000000000001')")
        self.conn.execute("INSERT INTO property_charge_matches (title_number, charge_id, match_method, match_evidence, reviewer_note) VALUES ('TEST1','00000000-0000-0000-0000-000000000001','manual','{}'::jsonb,'keep review')")
        reviews = capture(self.conn, 'TEST1')[2]
        self.assertEqual(apply_title(self.conn, DEC, 'TEST1', None, True)['action'], 'retired')
        self.assertEqual(capture(self.conn, 'TEST1')[2], reviews)
        self.assertEqual(ccod.counts(self.conn), (1, 1, 1))

    def test_missing_price_and_boundary_retire(self):
        for value, reason in [('', 'price_missing'), ('5000000', 'recorded_price_not_above_threshold')]:
            with self.conn.transaction():
                self.pending_receipt()
                result = apply_title(self.conn, DEC, 'TEST1', self.parsed(**{'Price Paid': value}), True)
                self.assertEqual(result['retirement_reason'], reason)
                raise psycopg.Rollback()

    def test_reactivation(self):
        self.pending_receipt()
        apply_title(self.conn, DEC, 'TEST1', None, True)
        self.pending_receipt(JAN)
        self.assertEqual(apply_title(self.conn, JAN, 'TEST1', self.parsed(), True)['action'], 'reactivated')

    def test_new_title_added(self):
        self.pending_receipt()
        result = apply_title(self.conn, DEC, 'NEW1', self.parsed(**{'Title Number': 'NEW1'}), True)
        self.assertEqual(result['action'], 'added')
        self.assertEqual(ccod.counts(self.conn), (2, 2, 0))

    def test_sample_not_retired(self):
        self.pending_receipt()
        self.conn.execute('UPDATE ccod_import.refresh_membership SET managed_high_value = false, retain_sample = true')
        self.assertEqual(apply_title(self.conn, DEC, 'TEST1', None, True)['action'], 'protected_sample')
        self.assertTrue(self.conn.execute('SELECT active FROM ccod_import.refresh_membership').fetchone()[0])

    def test_identical_source_has_no_history_event(self):
        self.pending_receipt()
        self.assertEqual(apply_title(self.conn, DEC, 'TEST1', self.parsed(), True)['action'], 'unchanged')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.property_history').fetchone()[0], 0)

    def test_same_month_cannot_be_mutated_twice(self):
        self.pending_receipt()
        apply_title(self.conn, DEC, 'TEST1', self.parsed(), True)
        with self.assertRaises(ccod.SafeError):
            apply_title(self.conn, DEC, 'TEST1', self.parsed(**{'Property Address': 'Unexpected'}), True)

    def test_incomplete_snapshot_rejected(self):
        with self.assertRaises(ccod.SafeError):
            apply_title(self.conn, DEC, 'TEST1', self.parsed(), False)

    def test_outer_rollback_reverts_updates_history_and_receipt(self):
        before = capture(self.conn, 'TEST1')
        with self.conn.transaction():
            self.pending_receipt()
            apply_title(self.conn, DEC, 'TEST1', self.parsed(**{'Property Address': 'Rollback address'}), True)
            raise psycopg.Rollback()
        self.assertEqual(capture(self.conn, 'TEST1'), before)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.property_history').fetchone()[0], 0)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
