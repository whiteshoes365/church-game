-- Additive migration for question reports and review state.
-- Schema: church_game (same as attendance / talent records).
-- Does not alter or delete existing tables or rows.
-- Apply to production only after explicit approval.

CREATE TABLE IF NOT EXISTS church_game.question_reports (
  id uuid PRIMARY KEY,
  question_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('host', 'student')),
  reason text NOT NULL CHECK (reason IN ('wrong_answer', 'ambiguous', 'inappropriate', 'typo', 'other')),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 200),
  device_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_reports_unique_device UNIQUE (question_id, device_hash)
);

CREATE INDEX IF NOT EXISTS question_reports_question_id_idx
  ON church_game.question_reports (question_id);

CREATE TABLE IF NOT EXISTS church_game.question_reviews (
  question_id text PRIMARY KEY,
  hidden boolean NOT NULL DEFAULT false,
  suggestion jsonb,
  action text,
  reviewed_at timestamptz
);

ALTER TABLE church_game.question_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE church_game.question_reviews ENABLE ROW LEVEL SECURITY;

-- No policies: Data API clients (anon / authenticated) cannot read or write.
-- The game server uses the service role, matching other church_game tables.
REVOKE ALL ON TABLE church_game.question_reports FROM PUBLIC;
REVOKE ALL ON TABLE church_game.question_reviews FROM PUBLIC;
REVOKE ALL ON TABLE church_game.question_reports FROM anon, authenticated;
REVOKE ALL ON TABLE church_game.question_reviews FROM anon, authenticated;
GRANT ALL ON TABLE church_game.question_reports TO postgres, service_role;
GRANT ALL ON TABLE church_game.question_reviews TO postgres, service_role;
