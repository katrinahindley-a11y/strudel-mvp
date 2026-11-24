-- UNAPPLIED REPLACEMENT DRAFT. CI uses a disposable database only.
BEGIN;
DO $$ BEGIN
  IF current_database()<>'neondb' OR NOT EXISTS(SELECT 1 FROM ccod_import.target_guard WHERE id=1 AND target_name='england-wales-property-test') THEN RAISE EXCEPTION 'IDENTITY_REVIEW_TARGET_REJECTED'; END IF;
END $$;
CREATE TABLE ccod_import.identity_review_principals(database_login name PRIMARY KEY,enabled boolean NOT NULL DEFAULT false,can_authorize_scan boolean NOT NULL DEFAULT false);
CREATE TABLE ccod_import.identity_review_proposals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_hash text NOT NULL CHECK(proposal_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),profile_evidence jsonb NOT NULL CHECK(jsonb_typeof(profile_evidence)='object'),profile_observed_at timestamptz NOT NULL,
  CHECK(payload->>'proposalHash' IS NOT NULL AND payload->>'proposalHash'=proposal_hash),UNIQUE(id,proposal_hash));
CREATE TABLE ccod_import.identity_review_events(
  event_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,proposal_id uuid NOT NULL,proposal_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN('identity','scan')),decision text NOT NULL CHECK(decision IN('approve','hold','reject','revoke')),
  actor_database_login name NOT NULL REFERENCES ccod_import.identity_review_principals(database_login),rationale text NOT NULL CHECK(length(btrim(rationale))>0),reviewed_at timestamptz NOT NULL,expires_at timestamptz,
  FOREIGN KEY(proposal_id,proposal_hash) REFERENCES ccod_import.identity_review_proposals(id,proposal_hash),
  CHECK((decision='approve' AND expires_at IS NOT NULL AND expires_at>reviewed_at AND expires_at<=reviewed_at+interval '7 days') OR (decision<>'approve' AND expires_at IS NULL)),UNIQUE(proposal_id,proposal_hash,event_sequence));
CREATE INDEX identity_review_latest_event_idx ON ccod_import.identity_review_events(proposal_id,purpose,event_sequence DESC);
ALTER TABLE ccod_import.company_charge_scans DROP CONSTRAINT company_charge_scans_identity_status_check;
ALTER TABLE ccod_import.company_charge_scans ADD CONSTRAINT company_charge_scans_identity_status_check CHECK(identity_status IN('name_consistent_unverified','identity_review_approved'));
CREATE TABLE ccod_import.identity_review_scan_bindings(
  scan_id uuid PRIMARY KEY REFERENCES ccod_import.company_charge_scans(id),proposal_id uuid NOT NULL,proposal_hash text NOT NULL,identity_event bigint NOT NULL,scan_event bigint NOT NULL UNIQUE,original_source jsonb NOT NULL CHECK(jsonb_typeof(original_source)='object'),
  FOREIGN KEY(proposal_id,proposal_hash,identity_event) REFERENCES ccod_import.identity_review_events(proposal_id,proposal_hash,event_sequence),
  FOREIGN KEY(proposal_id,proposal_hash,scan_event) REFERENCES ccod_import.identity_review_events(proposal_id,proposal_hash,event_sequence));
CREATE FUNCTION ccod_import.reject_identity_review_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'IDENTITY_REVIEW_APPEND_ONLY'; END $$;
CREATE TRIGGER immutable_identity_review_proposals BEFORE UPDATE OR DELETE OR TRUNCATE ON ccod_import.identity_review_proposals FOR EACH STATEMENT EXECUTE FUNCTION ccod_import.reject_identity_review_mutation();
CREATE TRIGGER immutable_identity_review_events BEFORE UPDATE OR DELETE OR TRUNCATE ON ccod_import.identity_review_events FOR EACH STATEMENT EXECUTE FUNCTION ccod_import.reject_identity_review_mutation();
CREATE TRIGGER immutable_identity_review_bindings BEFORE UPDATE OR DELETE OR TRUNCATE ON ccod_import.identity_review_scan_bindings FOR EACH STATEMENT EXECUTE FUNCTION ccod_import.reject_identity_review_mutation();
CREATE FUNCTION ccod_import.append_identity_review_event(p_id uuid,p_hash text,p_purpose text,p_decision text,p_rationale text,p_expires timestamptz DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result_id bigint; event_time timestamptz;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM ccod_import.identity_review_principals WHERE database_login=session_user AND enabled AND (p_purpose='identity' OR (p_purpose='scan' AND can_authorize_scan))) THEN RAISE EXCEPTION 'AUTHENTICATED_IDENTITY_REVIEWER_REQUIRED'; END IF;
  PERFORM 1 FROM ccod_import.identity_review_proposals WHERE id=p_id AND proposal_hash=p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDENTITY_PROPOSAL_NOT_FOUND'; END IF;
  event_time:=clock_timestamp();
  INSERT INTO ccod_import.identity_review_events(proposal_id,proposal_hash,purpose,decision,actor_database_login,rationale,reviewed_at,expires_at) VALUES(p_id,p_hash,p_purpose,p_decision,session_user,p_rationale,event_time,p_expires) RETURNING event_sequence INTO result_id;
  RETURN result_id;
END $$;
CREATE FUNCTION ccod_import.lock_identity_review_proposal(p_id uuid,p_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM 1 FROM ccod_import.identity_review_proposals WHERE id=p_id AND proposal_hash=p_hash FOR UPDATE; RETURN FOUND; END $$;
CREATE FUNCTION ccod_import.lock_identity_review_principal(p_login name,p_scan boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN SELECT(enabled AND (NOT p_scan OR can_authorize_scan)) INTO allowed FROM ccod_import.identity_review_principals WHERE database_login=p_login FOR SHARE; RETURN COALESCE(allowed,false); END $$;
CREATE FUNCTION ccod_import.lock_identity_review_source(p_title text,p_position smallint) RETURNS TABLE(dataset text,release text,"titleNumber" text,"proprietorPosition" text,"proprietorName" text,"registrationRaw" text,"candidateNumber" text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT t.source_dataset,to_char(t.source_snapshot_month,'YYYY-MM-DD'),p.title_number,p.proprietor_position::text,p.proprietor_name,p.registration_number_raw,p.company_number_candidate
  FROM public.property_proprietors p JOIN public.property_titles t ON t.title_number=p.title_number JOIN ccod_import.refresh_membership m ON m.title_number=t.title_number
  WHERE p.title_number=p_title AND p.proprietor_position=p_position AND t.source_dataset='CCOD' AND t.price_paid>5000000 AND m.managed_high_value=true AND m.active=true AND m.last_checked_month=t.source_snapshot_month FOR SHARE OF p,t,m
$$;
REVOKE ALL ON ccod_import.identity_review_principals,ccod_import.identity_review_proposals,ccod_import.identity_review_events,ccod_import.identity_review_scan_bindings FROM PUBLIC;
REVOKE ALL ON SEQUENCE ccod_import.identity_review_events_event_sequence_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION ccod_import.append_identity_review_event(uuid,text,text,text,text,timestamptz),ccod_import.lock_identity_review_proposal(uuid,text),ccod_import.lock_identity_review_principal(name,boolean),ccod_import.lock_identity_review_source(text,smallint),ccod_import.reject_identity_review_mutation() FROM PUBLIC;
COMMIT;
