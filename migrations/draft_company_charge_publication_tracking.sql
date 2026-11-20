-- DRAFT ONLY. Requires the scan-tracking migration; do not apply automatically.
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'neondb' OR NOT EXISTS (SELECT 1 FROM ccod_import.target_guard
    WHERE id = 1 AND target_name = 'england-wales-property-test') THEN
    RAISE EXCEPTION 'Unapproved charge-publication migration target';
  END IF;
END $$;
ALTER TABLE ccod_import.company_charge_scan_state
  ADD COLUMN last_published_scan_id uuid,
  ADD COLUMN last_published_at timestamptz,
  ADD CONSTRAINT company_charge_publication_scan_fk FOREIGN KEY (company_number, last_published_scan_id)
    REFERENCES ccod_import.company_charge_scans(company_number, id),
  ADD CONSTRAINT company_charge_publication_pair_check CHECK
    ((last_published_scan_id IS NULL AND last_published_at IS NULL)
     OR (last_published_scan_id IS NOT NULL AND last_published_at IS NOT NULL));
COMMIT;
