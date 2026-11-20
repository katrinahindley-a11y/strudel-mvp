-- DRAFT: source file only. Apply separately after migration review and isolated-branch testing.
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'neondb' OR NOT EXISTS (
    SELECT 1 FROM ccod_import.target_guard WHERE id = 1 AND target_name = 'england-wales-property-test'
  ) THEN RAISE EXCEPTION 'Unapproved charge-scan migration target'; END IF;
END $$;

CREATE TABLE ccod_import.company_charge_scans (
  id uuid PRIMARY KEY,
  company_number text NOT NULL CHECK (company_number ~ '^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$'),
  company_profile jsonb NOT NULL,
  charges jsonb NOT NULL CHECK (jsonb_typeof(charges) = 'array'),
  records_seen integer NOT NULL CHECK (records_seen >= 0 AND records_seen = jsonb_array_length(charges)),
  pages_fetched integer NOT NULL CHECK (pages_fetched > 0),
  identity_status text NOT NULL CHECK (identity_status = 'name_consistent_unverified'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_number, id)
);
CREATE INDEX company_charge_scans_company_time_idx ON ccod_import.company_charge_scans(company_number, completed_at DESC);

CREATE TABLE ccod_import.company_charge_scan_state (
  company_number text PRIMARY KEY CHECK (company_number ~ '^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  attempt_token uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempted_at timestamptz,
  last_successful_scan_id uuid,
  last_successful_at timestamptz,
  last_successful_charge_count integer CHECK (last_successful_charge_count >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_number, last_successful_scan_id) REFERENCES ccod_import.company_charge_scans(company_number, id),
  CHECK ((last_successful_scan_id IS NULL AND last_successful_at IS NULL AND last_successful_charge_count IS NULL)
      OR (last_successful_scan_id IS NOT NULL AND last_successful_at IS NOT NULL AND last_successful_charge_count IS NOT NULL))
);
CREATE INDEX company_charge_scan_state_status_idx ON ccod_import.company_charge_scan_state(status, last_successful_at);
COMMENT ON TABLE ccod_import.company_charge_scans IS 'Complete staged snapshots only; not automatically published to public.charges or lender search.';
COMMIT;
