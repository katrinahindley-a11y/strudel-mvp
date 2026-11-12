import csv
import datetime as dt
import io
import unittest
import zipfile
from unittest.mock import patch
import test_ccod_refresh_schema as schema
from test_ccod_import import fixture
import ccod_import as ccod
import ccod_refresh_coordinator as coordinator
from ccod_refresh_update import capture

TODAY = dt.date(2026, 12, 20)
RESOURCE = 'CCOD_FULL_2026_12.zip'

def full_archive(rows, footer=True, count=None):
    text = io.StringIO(newline='')
    writer = csv.DictWriter(text, fieldnames=ccod.HEADERS)
    writer.writeheader()
    writer.writerows(rows)
    if footer:
        csv.writer(text).writerow(['Row Count:', len(rows) if count is None else count])
    binary = io.BytesIO()
    with zipfile.ZipFile(binary, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('source.csv', text.getvalue())
    binary.seek(0)
    return zipfile.ZipFile(binary)

class CoordinatorTests(unittest.TestCase):
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

    def row(self, **changes):
        row = fixture(**{'Price Paid': '6000000'})
        row.update(changes)
        return row

    def run_refresh(self, rows=None, resource=RESOURCE, **archive_options):
        with full_archive([self.row()] if rows is None else rows, **archive_options) as archive:
            return coordinator.refresh_archive(self.conn, archive, resource, TODAY)

    def test_complete_release_updates_receipt_and_title(self):
        result = self.run_refresh([self.row(**{'Property Address': 'Updated'})])
        self.assertEqual(result['actions'], {'changed': 1})
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0], 2)

    def test_identical_repeat_is_exact_noop(self):
        self.run_refresh()
        before = capture(self.conn, 'TEST1')
        result = self.run_refresh()
        self.assertEqual(result['status'], 'already_applied')
        self.assertEqual(capture(self.conn, 'TEST1'), before)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0], 2)

    def test_same_month_different_contents_rejected(self):
        self.run_refresh()
        with self.assertRaisesRegex(ccod.SafeError, 'different contents'):
            self.run_refresh([self.row(**{'Property Address': 'Changed again'})])

    def test_old_release_rejected(self):
        self.run_refresh()
        with self.assertRaisesRegex(ccod.SafeError, 'Older release'):
            self.run_refresh(resource='CCOD_FULL_2026_11.zip')

    def test_missing_footer_causes_no_updates(self):
        before = capture(self.conn, 'TEST1')
        with self.assertRaises(ccod.SafeError):
            self.run_refresh([self.row(**{'Property Address': 'Must not save'})], footer=False)
        self.assertEqual(capture(self.conn, 'TEST1'), before)

    def test_wrong_footer_count_rejected(self):
        with self.assertRaises(ccod.SafeError):
            self.run_refresh(count=2)

    def test_duplicate_nonqualifying_title_rejected(self):
        low = self.row(**{'Title Number': 'LOW', 'Price Paid': '1'})
        with self.assertRaisesRegex(ccod.SafeError, 'Duplicate title'):
            self.run_refresh([self.row(), low, low])

    def test_mass_retirement_rejected(self):
        with self.assertRaisesRegex(ValueError, 'ten percent'):
            self.run_refresh([self.row(**{'Title Number': 'NEW'})])

    def test_new_qualifying_title_added(self):
        result = self.run_refresh([self.row(), self.row(**{'Title Number': 'NEW'})])
        self.assertEqual(result['qualified_count'], 2)
        self.assertEqual(ccod.counts(self.conn), (2, 2, 0))

    def test_insufficient_storage_rejected(self):
        before = capture(self.conn, 'TEST1')
        with patch.object(coordinator, 'database_bytes', return_value=coordinator.BUDGET), self.assertRaises(ccod.SafeError):
            self.run_refresh()
        self.assertEqual(capture(self.conn, 'TEST1'), before)

    def test_mid_batch_failure_rolls_back_everything(self):
        before = capture(self.conn, 'TEST1')
        original = coordinator.apply_title
        calls = []
        def failing(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise ccod.SafeError('Synthetic batch failure')
            return original(*args, **kwargs)
        with patch.object(coordinator, 'apply_title', side_effect=failing), self.assertRaises(ccod.SafeError):
            self.run_refresh([self.row(), self.row(**{'Title Number': 'NEW'})])
        self.assertEqual(ccod.counts(self.conn), (1, 1, 0))
        self.assertEqual(capture(self.conn, 'TEST1'), before)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.refresh_runs').fetchone()[0], 1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM ccod_import.property_history').fetchone()[0], 0)

    def test_future_release_rejected(self):
        with self.assertRaisesRegex(ccod.SafeError, 'Future release'):
            self.run_refresh(resource='CCOD_FULL_2027_01.zip')

if __name__ == '__main__':
    unittest.main()
