// Database schema, applied automatically (idempotent). Kept in TS so it bundles into the function.
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
-- eedbe Work platform schema. Idempotent; applied automatically on first request.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS platform_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- platform

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,             -- stored lowercase
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  industry    TEXT NOT NULL,                      -- preset key, e.g. 'tax_accounting_in', 'general'
  settings    JSONB NOT NULL DEFAULT '{}',        -- non-secret configuration
  secrets_enc TEXT,                               -- AES-256-GCM encrypted JSON (tokens, keys)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_features (
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  feature    TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, feature)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok    BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email_at ON login_attempts (email, at DESC);

-- ---------------------------------------------------------------- WhatsApp document assistant

-- A customer the business keeps documents for (person, firm, company...).
CREATE TABLE IF NOT EXISTS entities (
  id                SERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  entity_type       TEXT NOT NULL DEFAULT 'individual',
  key_date          DATE,                  -- DOB / incorporation date: used for PDF passwords
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_org ON entities (org_id);

-- Codes that appear on documents: PAN, GSTIN, policy no., customer ID...
CREATE TABLE IF NOT EXISTS identifiers (
  id        SERIAL PRIMARY KEY,
  org_id    UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id INT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  value     TEXT NOT NULL,
  label     TEXT,                          -- e.g. GST trade name
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, kind, value)
);

-- WhatsApp numbers allowed to ask for documents.
CREATE TABLE IF NOT EXISTS contacts (
  id              SERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_inbound_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone)
);

CREATE TABLE IF NOT EXISTS contact_entities (
  contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  entity_id  INT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, entity_id)
);

-- Kinds of document this business sends, with the words clients use for them.
CREATE TABLE IF NOT EXISTS doc_types (
  id              SERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  period_kind     TEXT NOT NULL DEFAULT 'none' CHECK (period_kind IN ('none', 'month', 'fy')),
  identifier_kind TEXT,                    -- documents belong to one identifier of this kind (e.g. GSTIN)
  aliases         TEXT[] NOT NULL DEFAULT '{}',  -- words clients use
  text_patterns   TEXT[] NOT NULL DEFAULT '{}',  -- regexes that recognise the PDF's text
  path_patterns   TEXT[] NOT NULL DEFAULT '{}',  -- regexes on file/folder names
  bundle          TEXT[],                  -- if set, a request word that sends these types
  bundle_optional TEXT[] NOT NULL DEFAULT '{}',  -- members sent if on file, never chased
  priority        INT NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  storage       TEXT NOT NULL,             -- 'upload' | 'google_drive'
  file_id       TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  size_bytes    INT,
  modified_at   TIMESTAMPTZ,
  entity_id     INT REFERENCES entities(id) ON DELETE SET NULL,
  identifier_id INT REFERENCES identifiers(id) ON DELETE SET NULL,
  doc_type      TEXT,
  period_start  DATE,
  period_end    DATE,
  password_rule TEXT,                      -- source already locked: 'id_date' | 'date' | 'unknown'
  status        TEXT NOT NULL DEFAULT 'review', -- 'indexed' | 'review' | 'missing'
  review_reason TEXT,
  classified_by TEXT,                      -- 'rules' | 'path' | 'ai' | 'staff'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, storage, file_id)
);
CREATE INDEX IF NOT EXISTS documents_lookup ON documents (org_id, entity_id, doc_type, period_end DESC) WHERE status = 'indexed';
CREATE INDEX IF NOT EXISTS documents_status ON documents (org_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pending_requests (
  id            SERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  contact_id    INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  entity_id     INT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  identifier_id INT REFERENCES identifiers(id) ON DELETE SET NULL,
  doc_type      TEXT NOT NULL,
  period_start  DATE,
  period_end    DATE,
  reason        TEXT NOT NULL,             -- 'missing' | 'approval'
  document_id   INT REFERENCES documents(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'fulfilled' | 'rejected'
  raw_message   TEXT,
  simulated     BOOLEAN NOT NULL DEFAULT FALSE, -- raised from the dashboard's test chat; never delivered on WhatsApp
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pending_open ON pending_requests (org_id, entity_id, doc_type) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS chat_sessions (
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  state      JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, phone)
);

CREATE TABLE IF NOT EXISTS processed_messages (
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  wa_message_id TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, wa_message_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  phone       TEXT,
  contact_id  INT,
  direction   TEXT NOT NULL,               -- 'in' | 'out' | 'system'
  event       TEXT NOT NULL,
  document_id INT,
  simulated   BOOLEAN NOT NULL DEFAULT FALSE,
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS audit_org_at ON audit_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_org_phone ON audit_log (org_id, phone, at DESC);

CREATE TABLE IF NOT EXISTS org_kv (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
`;
