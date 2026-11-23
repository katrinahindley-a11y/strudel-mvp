-- DRAFT ONLY. Do not apply to Neon or production without separate approval.
-- Each reviewer must use an individually authenticated PostgreSQL login.
-- Shared application/CI credentials must never be enrolled as reviewers.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'neondb' OR NOT EXISTS (
    SELECT 1 FROM ccod_import.target_guard
    WHERE id = 1 AND target_name = 'england-wales-property-test'
  ) THEN RAISE EXCEPTION 'IDENTITY_REVIEW_TARGET_REJECTED'; END IF;
END $$;

CREATE TABLE ccod_import.identity_review_principals (
  database_login name PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE ccod_import.identity_review_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (payload->>'proposalHash' IS NOT NULL AND payload->>'proposalHash' = proposal_hash),
  UNIQUE (id, proposal_hash)
);
CREATE TABLE ccod_import.identity_review_events (
  event_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id uuid NOT NULL,
  proposal_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'hold', 'reject', 'revoke')),
  actor_database_login name NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) > 0),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  FOREIGN KEY (proposal_id, proposal_hash)
    REFERENCES ccod_import.identity_review_proposals(id, proposal_hash),
  CHECK ((decision = 'approve' AND expires_at IS NOT NULL AND expires_at > reviewed_at)
      OR (decision <> 'approve' AND expires_at IS NULL))
);
CREATE INDEX identity_review_latest_event_idx
  ON ccod_import.identity_review_events(proposal_id, event_sequence DESC);

CREATE FUNCTION ccod_import.reject_identity_review_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'IDENTITY_REVIEW_APPEND_ONLY'; END $$;
CREATE TRIGGER immutable_identity_review_proposals
BEFORE UPDATE OR DELETE OR TRUNCATE ON ccod_import.identity_review_proposals
FOR EACH STATEMENT EXECUTE FUNCTION ccod_import.reject_identity_review_mutation();
CREATE TRIGGER immutable_identity_review_events
BEFORE UPDATE OR DELETE OR TRUNCATE ON ccod_import.identity_review_events
FOR EACH STATEMENT EXECUTE FUNCTION ccod_import.reject_identity_review_mutation();

CREATE FUNCTION ccod_import.append_identity_review_event(
  p_proposal_id uuid, p_proposal_hash text, p_decision text,
  p_rationale text, p_expires_at timestamptz DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result_id bigint; event_time timestamptz := clock_timestamp();
BEGIN
  -- session_user is the authenticated database login, not a request-body field.
  IF NOT EXISTS (SELECT 1 FROM ccod_import.identity_review_principals
                 WHERE database_login = session_user AND enabled) THEN
    RAISE EXCEPTION 'AUTHENTICATED_IDENTITY_REVIEWER_REQUIRED';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'hold', 'reject', 'revoke')
     OR p_rationale IS NULL OR length(btrim(p_rationale)) = 0 THEN
    RAISE EXCEPTION 'IDENTITY_REVIEW_INVALID';
  END IF;
  IF (p_decision = 'approve' AND (p_expires_at IS NULL OR p_expires_at <= event_time
                               OR p_expires_at > event_time + interval '7 days'))
     OR (p_decision <> 'approve' AND p_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'IDENTITY_REVIEW_EXPIRY_INVALID';
  END IF;
  -- Serialise decisions for the same proposal, so a revocation supersedes approval.
  PERFORM 1 FROM ccod_import.identity_review_proposals
    WHERE id = p_proposal_id AND proposal_hash = p_proposal_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDENTITY_PROPOSAL_NOT_FOUND'; END IF;
  INSERT INTO ccod_import.identity_review_events
    (proposal_id, proposal_hash, decision, actor_database_login, rationale, reviewed_at, expires_at)
  VALUES (p_proposal_id, p_proposal_hash, p_decision, session_user, p_rationale, event_time, p_expires_at)
  RETURNING event_sequence INTO result_id;
  RETURN result_id;
END $$;

-- No role is created, enrolled, or granted access by this draft.
REVOKE ALL ON ccod_import.identity_review_principals,
  ccod_import.identity_review_proposals, ccod_import.identity_review_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE ccod_import.identity_review_events_event_sequence_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION ccod_import.append_identity_review_event(uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ccod_import.reject_identity_review_mutation() FROM PUBLIC;
COMMENT ON TABLE ccod_import.identity_review_proposals IS
  'Unmodified offline proposal payloads. Application validates their canonical hashes; hashes are not authentication.';
COMMENT ON TABLE ccod_import.identity_review_events IS
  'Append-only decisions; newest event wins, expires and remains subject to source and profile revalidation. Not scan authorization.';
COMMIT;
