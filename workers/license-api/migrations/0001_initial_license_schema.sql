-- =============================================================================
-- StockStudio Pro v0.2.0-D-B — Migration 0001: Initial License Schema
-- Source of Truth: docs/license/v0.2.0-D-A-database-schema.sql
-- Product Identifier: com.stockstudiopro.desktop
-- Engine: Cloudflare D1 (SQLite 3 compatible)
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. TABLE: signing_keys
-- Metadata for asymmetric Ed25519 keys used to sign offline entitlement leases.
-- Private keys live ONLY in Cloudflare Secrets; D1 stores public key metadata
-- and key rotation status.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signing_keys (
    kid                 TEXT PRIMARY KEY,
    algorithm           TEXT NOT NULL DEFAULT 'Ed25519'
                        CHECK (algorithm IN ('Ed25519')),
    public_key_base64   TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'verify_only', 'retired')),
    created_at          TEXT NOT NULL,
    rotated_at          TEXT,
    retired_at          TEXT
);

-- -----------------------------------------------------------------------------
-- 2. TABLE: admin_api_keys
-- Server-side administrative principals for /v1/admin/* endpoints.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_api_keys (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    key_prefix          TEXT NOT NULL UNIQUE,
    key_hash            TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL
                        CHECK (role IN ('super_admin', 'support_admin', 'billing_system', 'read_only')),
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'revoked')),
    allowed_ips_json    TEXT,
    last_used_at        TEXT,
    expires_at          TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    revoked_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_api_keys_status
    ON admin_api_keys (status);

-- -----------------------------------------------------------------------------
-- 3. TABLE: licenses
-- Unified entitlement table for both PERPETUAL and SUBSCRIPTION licenses.
-- Billing records remain decoupled in billing_subscriptions / billing_events.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS licenses (
    id                      TEXT PRIMARY KEY,
    product_id              TEXT NOT NULL DEFAULT 'com.stockstudiopro.desktop'
                            CHECK (product_id = 'com.stockstudiopro.desktop'),

    -- Key identification & cryptographic hash (never plaintext)
    key_prefix              TEXT NOT NULL,
    key_hash                TEXT NOT NULL UNIQUE,
    key_pepper_version      INTEGER NOT NULL DEFAULT 1,

    -- Plan & dual-model classification
    plan_code               TEXT NOT NULL,
    plan_name               TEXT NOT NULL,
    license_type            TEXT NOT NULL
                            CHECK (license_type IN ('perpetual', 'subscription')),
    billing_interval        TEXT NOT NULL
                            CHECK (billing_interval IN ('lifetime', 'monthly', 'yearly')),

    -- Lifecycle status
    status                  TEXT NOT NULL DEFAULT 'pending_activation'
                            CHECK (status IN (
                                'pending_activation',
                                'active',
                                'past_due',
                                'expired',
                                'suspended',
                                'revoked'
                            )),

    -- Device binding quota (atomic counter guarded by D1 transaction)
    device_limit            INTEGER NOT NULL DEFAULT 2
                            CHECK (device_limit >= 1 AND device_limit <= 100),
    active_devices_count    INTEGER NOT NULL DEFAULT 0
                            CHECK (active_devices_count >= 0 AND active_devices_count <= device_limit),

    -- Validity & subscription period tracking (NULL for perpetual licenses)
    issued_at               TEXT NOT NULL,
    activated_at            TEXT,
    current_period_start    TEXT,
    current_period_end      TEXT,
    expires_at              TEXT,
    grace_until             TEXT,
    cancel_at_period_end    INTEGER NOT NULL DEFAULT 0
                            CHECK (cancel_at_period_end IN (0, 1)),
    canceled_at             TEXT,

    -- Update & feature entitlements (JSON object)
    updates_until           TEXT,
    max_app_version         TEXT,
    entitlements_json       TEXT NOT NULL DEFAULT '{"features":["google_flow_workspace","multi_account_manager","unlimited_accounts"]}',

    -- Customer metadata & audit status
    customer_email          TEXT,
    customer_name           TEXT,
    external_customer_id    TEXT,
    external_order_id       TEXT,
    suspended_at            TEXT,
    suspension_reason       TEXT,
    revoked_at              TEXT,
    revocation_reason       TEXT,
    notes                   TEXT,
    idempotency_key         TEXT UNIQUE,
    created_by              TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,

    -- Cross-column integrity constraints enforcing Perpetual vs Subscription rules
    CHECK (
        (license_type = 'perpetual'
            AND billing_interval = 'lifetime'
            AND expires_at IS NULL
            AND current_period_start IS NULL
            AND current_period_end IS NULL)
        OR
        (license_type = 'subscription'
            AND billing_interval IN ('monthly', 'yearly')
            AND expires_at IS NOT NULL
            AND current_period_start IS NOT NULL
            AND current_period_end IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_licenses_key_prefix
    ON licenses (key_prefix);

CREATE INDEX IF NOT EXISTS idx_licenses_customer_email
    ON licenses (customer_email);

CREATE INDEX IF NOT EXISTS idx_licenses_status_expires
    ON licenses (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_licenses_external_order
    ON licenses (external_order_id);

-- -----------------------------------------------------------------------------
-- 4. TABLE: devices
-- Distinct client installations/hardware profiles observed by the license server.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id                  TEXT PRIMARY KEY,
    device_fingerprint  TEXT NOT NULL,
    device_name         TEXT NOT NULL,
    platform            TEXT NOT NULL DEFAULT 'windows'
                        CHECK (platform IN ('windows', 'macos', 'linux')),
    os_version          TEXT,
    arch                TEXT,
    last_app_version    TEXT,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_fingerprint
    ON devices (device_fingerprint);

-- -----------------------------------------------------------------------------
-- 5. TABLE: activations
-- Binding records linking a license to a device slot.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activations (
    id                      TEXT PRIMARY KEY,
    license_id              TEXT NOT NULL
                            REFERENCES licenses(id) ON DELETE RESTRICT,
    device_id               TEXT NOT NULL
                            REFERENCES devices(id) ON DELETE RESTRICT,
    device_fingerprint      TEXT NOT NULL,
    device_name_snapshot    TEXT NOT NULL,
    app_version_snapshot    TEXT NOT NULL,

    -- Authentication token for validate / deactivate calls (SHA-256 hash only)
    token_prefix            TEXT NOT NULL,
    token_hash              TEXT NOT NULL UNIQUE,

    -- Current lease metadata
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'deactivated', 'revoked', 'expired')),
    last_lease_jti          TEXT,
    last_lease_issued_at    TEXT NOT NULL,
    last_lease_expires_at   TEXT NOT NULL,

    -- Lifecycle timestamps
    activated_at            TEXT NOT NULL,
    last_validated_at       TEXT NOT NULL,
    last_seen_ip_hash       TEXT,
    deactivated_at          TEXT,
    deactivated_by          TEXT,
    deactivation_reason     TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_unique_active_device
    ON activations (license_id, device_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_unique_active_fingerprint
    ON activations (license_id, device_fingerprint)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_activations_license_status
    ON activations (license_id, status);

CREATE INDEX IF NOT EXISTS idx_activations_device_id
    ON activations (device_id);

-- -----------------------------------------------------------------------------
-- 6. TABLE: billing_subscriptions
-- Payment-provider-independent subscription state linked 1:1 with a subscription
-- license.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                          TEXT PRIMARY KEY,
    license_id                  TEXT NOT NULL UNIQUE
                                REFERENCES licenses(id) ON DELETE RESTRICT,
    provider                    TEXT NOT NULL,
    external_customer_id        TEXT,
    external_subscription_id    TEXT NOT NULL,
    external_plan_id            TEXT,
    billing_interval            TEXT NOT NULL
                                CHECK (billing_interval IN ('monthly', 'yearly')),
    provider_status             TEXT NOT NULL,
    currency                    TEXT,
    unit_amount_minor           INTEGER,
    current_period_start        TEXT NOT NULL,
    current_period_end          TEXT NOT NULL,
    cancel_at_period_end        INTEGER NOT NULL DEFAULT 0
                                CHECK (cancel_at_period_end IN (0, 1)),
    canceled_at                 TEXT,
    last_payment_event_id       TEXT,
    last_payment_at             TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,

    UNIQUE (provider, external_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer
    ON billing_subscriptions (provider, external_customer_id);

-- -----------------------------------------------------------------------------
-- 7. TABLE: billing_events
-- Immutable idempotency ledger of all incoming payment/renewal events.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_events (
    id                      TEXT PRIMARY KEY,
    provider                TEXT NOT NULL,
    provider_event_id       TEXT NOT NULL,
    canonical_event_type    TEXT NOT NULL
                            CHECK (canonical_event_type IN (
                                'payment.succeeded',
                                'payment.failed',
                                'subscription.created',
                                'subscription.renewed',
                                'subscription.canceled',
                                'payment.refunded',
                                'payment.chargeback'
                            )),
    license_id              TEXT
                            REFERENCES licenses(id) ON DELETE SET NULL,
    billing_subscription_id TEXT
                            REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
    external_invoice_id     TEXT,
    amount_minor            INTEGER,
    currency                TEXT,
    period_start_granted    TEXT,
    period_end_granted      TEXT,
    processing_status       TEXT NOT NULL DEFAULT 'processed'
                            CHECK (processing_status IN ('processed', 'ignored', 'failed')),
    payload_sha256          TEXT NOT NULL,
    error_message           TEXT,
    occurred_at             TEXT NOT NULL,
    processed_at            TEXT NOT NULL,

    UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_events_license
    ON billing_events (license_id, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- 8. TABLE: license_events
-- Append-only immutable audit log for all license lifecycle, device activation,
-- validation failure, administrative action, and billing state transitions.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS license_events (
    id                  TEXT PRIMARY KEY,
    license_id          TEXT
                        REFERENCES licenses(id) ON DELETE SET NULL,
    activation_id       TEXT
                        REFERENCES activations(id) ON DELETE SET NULL,
    device_id           TEXT,
    event_type          TEXT NOT NULL
                        CHECK (event_type IN (
                            'license.issued',
                            'license.activated',
                            'license.rebound_on_reinstall',
                            'license.validated',
                            'license.validation_failed',
                            'license.device_limit_rejected',
                            'license.deactivated',
                            'license.expired',
                            'license.past_due',
                            'license.renewed',
                            'license.suspended',
                            'license.reinstated',
                            'license.revoked',
                            'license.updated'
                        )),
    actor_type          TEXT NOT NULL
                        CHECK (actor_type IN ('client', 'admin', 'billing_webhook', 'system')),
    actor_id            TEXT,
    previous_status     TEXT,
    new_status          TEXT,
    ip_hash             TEXT,
    user_agent          TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_events_license_created
    ON license_events (license_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_license_events_type_created
    ON license_events (event_type, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. TABLE: rate_limit_buckets
-- Persistent D1 rate limiter & lockout bucket for key_prefix and IP hashes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key          TEXT PRIMARY KEY,
    window_start        INTEGER NOT NULL,
    attempt_count       INTEGER NOT NULL DEFAULT 1,
    locked_until        INTEGER,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_updated
    ON rate_limit_buckets (updated_at);
