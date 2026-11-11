BEGIN;

CREATE TABLE property_titles (
    title_number TEXT PRIMARY KEY,
    tenure TEXT NOT NULL,
    property_address TEXT,
    district TEXT,
    county TEXT,
    region TEXT,
    postcode TEXT,

    multiple_address_indicator BOOLEAN,
    additional_proprietor_indicator BOOLEAN,

    price_paid NUMERIC(18,2),
    date_proprietor_added DATE,

    source_dataset TEXT NOT NULL DEFAULT 'CCOD',
    source_snapshot_month DATE NOT NULL,
    raw_data JSONB NOT NULL,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT property_titles_price_nonnegative
        CHECK (price_paid IS NULL OR price_paid >= 0),

    CONSTRAINT property_titles_snapshot_month_start
        CHECK (
            EXTRACT(DAY FROM source_snapshot_month) = 1
        )
);

CREATE INDEX property_titles_postcode_idx
    ON property_titles (postcode);

CREATE INDEX property_titles_district_idx
    ON property_titles (district);

CREATE TABLE property_proprietors (
    title_number TEXT NOT NULL
        REFERENCES property_titles(title_number)
        ON DELETE CASCADE,

    proprietor_position SMALLINT NOT NULL,

    proprietor_name TEXT NOT NULL,
    registration_number_raw TEXT,
    company_number_candidate TEXT,
    proprietorship_category TEXT,

    address_1 TEXT,
    address_2 TEXT,
    address_3 TEXT,

    matched_company_id UUID
        REFERENCES companies(id)
        ON DELETE SET NULL,

    company_match_status TEXT NOT NULL DEFAULT 'unmatched',
    company_match_evidence JSONB,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (title_number, proprietor_position),

    CONSTRAINT property_proprietors_position_valid
        CHECK (proprietor_position BETWEEN 1 AND 4),

    CONSTRAINT property_proprietors_match_status_valid
        CHECK (
            company_match_status IN (
                'unmatched',
                'candidate',
                'verified',
                'needs_review'
            )
        ),

    CONSTRAINT property_proprietors_verified_has_company
        CHECK (
            company_match_status <> 'verified'
            OR matched_company_id IS NOT NULL
        )
);

CREATE INDEX property_proprietors_company_candidate_idx
    ON property_proprietors (company_number_candidate);

CREATE INDEX property_proprietors_matched_company_idx
    ON property_proprietors (matched_company_id);

CREATE TABLE property_charge_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    title_number TEXT NOT NULL
        REFERENCES property_titles(title_number)
        ON DELETE CASCADE,

    charge_id UUID NOT NULL
        REFERENCES charges(id)
        ON DELETE CASCADE,

    match_method TEXT NOT NULL,
    match_evidence JSONB NOT NULL,

    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    reviewed_at TIMESTAMPTZ,
    reviewer_note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (title_number, charge_id),

    CONSTRAINT property_charge_matches_method_valid
        CHECK (
            match_method IN (
                'title_number',
                'address',
                'manual'
            )
        ),

    CONSTRAINT property_charge_matches_review_valid
        CHECK (
            review_status IN (
                'unreviewed',
                'confirmed',
                'rejected'
            )
        )
);

CREATE INDEX property_charge_matches_charge_idx
    ON property_charge_matches (charge_id);

COMMENT ON COLUMN property_titles.price_paid IS
    'Recorded CCOD price paid; may be absent and must not be treated as current market value.';

COMMENT ON COLUMN property_titles.date_proprietor_added IS
    'CCOD Date Proprietor Added; not labelled as purchase date.';

COMMENT ON COLUMN property_titles.source_snapshot_month IS
    'Month identifying the source release, not a transaction date.';

COMMENT ON COLUMN property_proprietors.company_number_candidate IS
    'Normalised matching candidate; not a verified company identity.';

COMMENT ON TABLE property_charge_matches IS
    'Evidence-based title-to-charge matches. A company-level charge alone is not a property match.';

COMMIT;
