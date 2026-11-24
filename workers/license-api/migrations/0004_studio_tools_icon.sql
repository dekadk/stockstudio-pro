-- =============================================================================
-- StockStudio Pro — Migration 0004: Studio Tool Icon Selection
-- Additive column ONLY (zero destructive mutations).
-- =============================================================================

ALTER TABLE studio_tools
  ADD COLUMN icon TEXT NOT NULL DEFAULT 'sparkles';

UPDATE studio_tools SET icon = 'background' WHERE id = 'background';
UPDATE studio_tools SET icon = 'mascot' WHERE id = 'mascot';
UPDATE studio_tools SET icon = 'pattern' WHERE id = 'pattern';
UPDATE studio_tools SET icon = 'tag' WHERE id = 'aio-metadata';
