-- =============================================================================
-- StockStudio Pro — Migration 0003: Dynamic Remote Studio Tool Registry
-- Additive table ONLY (zero mutations to existing license/admin tables).
-- Allows Owner to edit tool URLs, add new Google Flow / Gemini Canvas tools,
-- and toggle individual tools ON/OFF dynamically for all active desktop users.
-- =============================================================================

CREATE TABLE IF NOT EXISTS studio_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Google Flow Tool',
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  badge TEXT NOT NULL DEFAULT 'FLOW',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_tools_sort
  ON studio_tools (sort_order ASC, created_at ASC);

-- Seed initial default Studio Tools (idempotent; preserves any existing edits)
INSERT OR IGNORE INTO studio_tools (
  id, name, category, description, url, badge, enabled, sort_order, created_at, updated_at
) VALUES
  (
    'background',
    'Background',
    'Google Flow Tool',
    'Generate clean microstock-ready backgrounds directly inside Google Flow.',
    'https://flow.google.com/shared/tool/91cce113-c49e-4021-81f3-0e2f3d2035c0',
    'FLOW',
    1,
    10,
    '2026-11-24T00:00:00Z',
    '2026-11-24T00:00:00Z'
  ),
  (
    'mascot',
    'Mascot',
    'Google Flow Tool',
    'Design consistent character and mascot illustrations with Google Flow.',
    'https://flow.google.com/shared/tool/26646271-d332-4385-b06d-a6f2758e9c54',
    'FLOW',
    1,
    20,
    '2026-11-24T00:00:00Z',
    '2026-11-24T00:00:00Z'
  ),
  (
    'pattern',
    'Pattern',
    'Google Flow Tool',
    'Create seamless repeating patterns and surface designs in Google Flow.',
    'https://flow.google.com/shared/tool/a3c286ba-7b8a-4b03-ac29-02bcc12d2281',
    'FLOW',
    1,
    30,
    '2026-11-24T00:00:00Z',
    '2026-11-24T00:00:00Z'
  ),
  (
    'aio-metadata',
    'AIO Metadata',
    'Metadata Tool',
    'Prepare microstock titles, descriptions, and keywords directly inside StockStudio Pro.',
    'https://share.gemini.google/CwUs3ZQJlnrk',
    'GEMINI',
    1,
    40,
    '2026-11-24T00:00:00Z',
    '2026-11-24T00:00:00Z'
  );
