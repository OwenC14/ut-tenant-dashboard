-- Consent flow (spec §9a.4) — versioned, append-only. A property's current
-- status for an agreement type is always "the most recent consent_records
-- row for that property_id + agreement_id", never inferred from row absence.
CREATE TABLE agreements (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('app_terms', 'ha_data_sharing')),
  version INTEGER NOT NULL,
  document_text_or_url TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, version)
);

CREATE TABLE consent_records (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'declined', 'withdrawn')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT,
  ip_address TEXT,
  user_agent TEXT
);
CREATE INDEX idx_consent_records_property_agreement ON consent_records (property_id, agreement_id, recorded_at DESC);

-- Placeholder documents -- NOT real legal text. Spec §9 decision 6 says the
-- ha_data_sharing document/clause was "clarified internally by UT" but isn't
-- included in the spec handed to this build. Replace both document_text_or_url
-- values with UT's real, legal-approved text/URL before any real tenant sees
-- this flow -- everything downstream (versioning, re-prompt on change) works
-- off whatever text lives in this table, so it's a content swap, not a code change.
INSERT INTO agreements (type, version, document_text_or_url) VALUES
  ('app_terms', 1, 'PLACEHOLDER -- replace with Union Technical''s real app terms of service before go-live.'),
  ('ha_data_sharing', 1, 'PLACEHOLDER -- replace with the real HA/LA data-sharing agreement text UT confirmed internally (spec section 9, decision 6) before go-live.');
