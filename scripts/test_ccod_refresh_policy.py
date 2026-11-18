import datetime as dt
import unittest
from ccod_refresh_policy import PolicyError, choose_release, qualification, retirement_reason, owner_transfer_map, check_retirement_budget

class RefreshPolicyTests(unittest.TestCase):
    def test_latest_available_release(self):
        files = [{'file_name': 'CCOD_FULL_2026_10.zip'}, {'name': 'CCOD_FULL_2026_11.zip'}, {'name': 'CCOD_COU_2026_11.zip'}]
        self.assertEqual(choose_release(files, dt.date(2026, 10, 1), dt.date(2026, 11, 12)), 'CCOD_FULL_2026_11.zip')

    def test_same_release_noop(self):
        self.assertIsNone(choose_release([{'name': 'CCOD_FULL_2026_11.zip'}], dt.date(2026, 11, 1), dt.date(2026, 11, 12)))

    def test_older_release_noop(self):
        self.assertIsNone(choose_release([{'name': 'CCOD_FULL_2026_10.zip'}], dt.date(2026, 11, 1), dt.date(2026, 11, 12)))

    def test_bad_or_future_release_rejected(self):
        for name in ['CCOD_FULL_2026_13.zip', 'CCOD_FULL_2026_12.zip']:
            with self.subTest(name=name), self.assertRaises(PolicyError):
                choose_release([{'name': name}], None, dt.date(2026, 11, 12))

    def test_no_full_release_rejected(self):
        with self.assertRaises(PolicyError):
            choose_release([], None, dt.date(2026, 11, 12))

    def test_strict_five_million_boundary(self):
        self.assertEqual(qualification({'price_paid': '5000000.01'}), 'qualifies')
        self.assertEqual(qualification({'price_paid': '5000000'}), 'recorded_price_not_above_threshold')

    def test_unknown_price_is_distinct_from_absence(self):
        self.assertEqual(qualification({'price_paid': None}), 'price_missing')
        self.assertEqual(qualification(None), 'absent_from_full_release')

    def test_invalid_prices_fail(self):
        for price in ['NaN', 'Infinity', '-1', 'invalid', True]:
            with self.subTest(price=price), self.assertRaises(PolicyError):
                qualification({'price_paid': price})

    def test_sample_not_retired(self):
        self.assertIsNone(retirement_reason('SAMPLE', {}, {'MANAGED'}, True))

    def test_incomplete_source_cannot_retire(self):
        with self.assertRaises(PolicyError):
            retirement_reason('A', {}, {'A'}, False)

    def test_retirement_reasons(self):
        self.assertEqual(retirement_reason('A', {}, {'A'}, True), 'absent_from_full_release')
        self.assertEqual(retirement_reason('A', {'A': {'price_paid': None}}, {'A'}, True), 'price_missing')
        self.assertEqual(retirement_reason('A', {'A': {'price_paid': 1}}, {'A'}, True), 'recorded_price_not_above_threshold')

    def test_qualifying_title_remains_active(self):
        self.assertIsNone(retirement_reason('A', {'A': {'price_paid': 6000000}}, {'A'}, True))

    def test_reordered_owner_keeps_identity_not_position(self):
        old = [{'proprietor_position': 1, 'proprietor_name': 'Owner A'}, {'proprietor_position': 2, 'proprietor_name': 'Owner B'}]
        new = [{'proprietor_position': 1, 'proprietor_name': 'Owner B'}, {'proprietor_position': 2, 'proprietor_name': 'Owner A'}]
        self.assertEqual(owner_transfer_map(old, new), {1: 2, 2: 1})

    def test_replacement_owner_cannot_inherit_match(self):
        self.assertEqual(owner_transfer_map([{'proprietor_position': 1, 'proprietor_name': 'Old'}], [{'proprietor_position': 1, 'proprietor_name': 'New'}]), {1: None})

    def test_changed_registration_cannot_inherit_match(self):
        old = [{'proprietor_position': 1, 'proprietor_name': 'Owner', 'registration_number_raw': '123'}]
        new = [{'proprietor_position': 1, 'proprietor_name': 'Owner', 'registration_number_raw': '456'}]
        self.assertEqual(owner_transfer_map(old, new), {1: None})

    def test_ambiguous_identity_requires_review(self):
        owners = [{'proprietor_position': 1, 'proprietor_name': 'Owner'}, {'proprietor_position': 2, 'proprietor_name': 'Owner'}]
        with self.assertRaises(PolicyError):
            owner_transfer_map(owners, [])

    def test_duplicate_positions_fail(self):
        with self.assertRaises(PolicyError):
            owner_transfer_map([], [{'proprietor_position': 1, 'proprietor_name': 'A'}, {'proprietor_position': 1, 'proprietor_name': 'B'}])

    def test_mass_retirement_requires_review(self):
        check_retirement_budget(100, 10)
        with self.assertRaises(PolicyError):
            check_retirement_budget(100, 11)

if __name__ == '__main__':
    unittest.main()
