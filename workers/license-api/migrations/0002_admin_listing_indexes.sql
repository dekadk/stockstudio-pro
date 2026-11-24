-- =============================================================================
-- StockStudio Pro — Migration 0002: Admin Read API Listing & Audit Indexes
-- Additive indexes ONLY (zero table/column mutations, zero dropped indexes).
-- Supports deterministic keyset cursor pagination on (created_at DESC, id DESC)
-- for GET /v1/admin/licenses and GET /v1/admin/events, plus plan/status filters.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_licenses_created_id
    ON licenses (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_licenses_plan_status
    ON licenses (plan_code, status);

CREATE INDEX IF NOT EXISTS idx_licenses_type_interval
    ON licenses (license_type, billing_interval);

CREATE INDEX IF NOT EXISTS idx_license_events_created_id
    ON license_events (created_at DESC, id DESC);
