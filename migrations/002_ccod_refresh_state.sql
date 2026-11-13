DO $$
BEGIN
  IF (SELECT target_name FROM ccod_import.target_guard WHERE id = 1) IS DISTINCT FROM 'england-wales-property-test' THEN
    RAISE EXCEPTION 'Test target guard missing or incorrect';
  END IF;
END $$;

CREATE TABLE ccod_import.refresh_runs (
  snapshot_month date PRIMARY KEY CHECK (EXTRACT(day FROM snapshot_month) = 1),
  resource_name text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_count bigint NOT NULL CHECK (source_count > 0),
  qualified_count bigint NOT NULL CHECK (qualified_count > 0 AND qualified_count <= source_count),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resource_name = 'CCOD_FULL_' || to_char(snapshot_month, 'YYYY_MM') || '.zip')
);

CREATE TABLE ccod_import.refresh_membership (
  title_number text PRIMARY KEY REFERENCES public.property_titles(title_number) ON DELETE RESTRICT,
  managed_high_value boolean NOT NULL,
  retain_sample boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  retirement_reason text CHECK (retirement_reason IN ('absent_from_full_release', 'price_missing', 'recorded_price_not_above_threshold')),
  last_checked_month date NOT NULL REFERENCES ccod_import.refresh_runs(snapshot_month) DEFERRABLE INITIALLY DEFERRED,
  last_seen_month date CHECK (EXTRACT(day FROM last_seen_month) = 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (managed_high_value OR retain_sample),
  CHECK ((active AND retirement_reason IS NULL) OR (NOT active AND managed_high_value AND retirement_reason IS NOT NULL)),
  CHECK (last_seen_month IS NULL OR last_seen_month <= last_checked_month)
);

CREATE TABLE ccod_import.property_history (
  snapshot_month date NOT NULL REFERENCES ccod_import.refresh_runs(snapshot_month) DEFERRABLE INITIALLY DEFERRED,
  title_number text NOT NULL REFERENCES public.property_titles(title_number) ON DELETE RESTRICT,
  event_kind text NOT NULL CHECK (event_kind IN ('baseline', 'added', 'changed', 'retired', 'reactivated')),
  title_before jsonb CHECK (title_before IS NULL OR jsonb_typeof(title_before) = 'object'),
  title_after jsonb CHECK (title_after IS NULL OR jsonb_typeof(title_after) = 'object'),
  owners_before jsonb NOT NULL CHECK (jsonb_typeof(owners_before) = 'array'),
  owners_after jsonb NOT NULL CHECK (jsonb_typeof(owners_after) = 'array'),
  charge_reviews_before jsonb NOT NULL CHECK (jsonb_typeof(charge_reviews_before) = 'array'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_month, title_number)
);
