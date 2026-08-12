CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_number TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    company_status TEXT,
    company_type TEXT,
    incorporation_date DATE,
    dissolution_date DATE,
    sic_codes TEXT[] NOT NULL DEFAULT '{}',
    registered_address JSONB,
    postcode TEXT,
    geom GEOMETRY(Point, 4326),
    source_updated_at TIMESTAMPTZ,
    last_fetched_at TIMESTAMPTZ,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX companies_name_search_idx
    ON companies USING GIN (to_tsvector('english', name));
CREATE INDEX companies_postcode_idx ON companies (postcode);
CREATE INDEX companies_status_idx ON companies (company_status);
CREATE INDEX companies_sic_codes_idx ON companies USING GIN (sic_codes);
CREATE INDEX companies_geom_idx ON companies USING GIST (geom);

CREATE TABLE officers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    date_of_birth_month INT,
    date_of_birth_year INT,
    nationality TEXT,
    occupation TEXT,
    address JSONB,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX officers_name_search_idx
    ON officers USING GIN (to_tsvector('english', name));

CREATE TABLE company_officers (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    officer_id UUID NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    role TEXT,
    appointed_on DATE,
    resigned_on DATE,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    raw_data JSONB,
    PRIMARY KEY (company_id, officer_id, appointed_on)
);

CREATE TABLE lenders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT NOT NULL UNIQUE,
    lender_type TEXT,
    is_competitor BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lender_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lender_id UUID NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
    raw_name TEXT NOT NULL UNIQUE,
    confidence NUMERIC(5,4),
    reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    external_charge_id TEXT NOT NULL,
    created_on DATE,
    delivered_on DATE,
    status TEXT,
    satisfied_on DATE,
    amount_secured NUMERIC(18,2),
    description TEXT,
    persons_entitled_raw JSONB,
    lender_id UUID REFERENCES lenders(id),
    raw_data JSONB,
    last_fetched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, external_charge_id)
);

CREATE INDEX charges_company_idx ON charges (company_id);
CREATE INDEX charges_status_idx ON charges (status);
CREATE INDEX charges_created_on_idx ON charges (created_on);
CREATE INDEX charges_lender_idx ON charges (lender_id);

CREATE TABLE lead_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    owner_name TEXT,
    filter_definition JSONB,
    is_dynamic BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lead_list_members (
    lead_list_id UUID NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'new',
    assigned_to TEXT,
    note TEXT,
    next_action TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lead_list_id, company_id)
);

CREATE TABLE company_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    to_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    confidence NUMERIC(5,4),
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (from_company_id, to_company_id, relationship_type)
);

CREATE TABLE ingestion_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    records_seen INT NOT NULL DEFAULT 0,
    records_written INT NOT NULL DEFAULT 0,
    error_message TEXT
);
