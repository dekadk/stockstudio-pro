-- =============================================================================
-- StockStudio Pro v0.2.0-D-A — Cloudflare D1 (SQLite) Database Schema
-- Product Identifier: com.stockstudiopro.desktop
-- Engine: Cloudflare D1 (SQLite 3 compatible)
--
-- Supports both license models in a unified schema:
--   1. PERPETUAL:    license_type = 'perpetual',    billing_interval = 'lifetime', expires_at IS NULL
--   2. SUBSCRIPTION: license_type = 'subscription', billing_interval IN ('monthly', 'yearly'), expires_at IS NOT NULL
--
-- Security Invariants:
--   - Plaintext license keys are NEVER stored. Only key_prefix and HMAC-SHA256 key_hash are persisted.
--   - Plaintext activation tokens and admin API keys are NEVER stored. Only SHA-256 / HMAC-SHA256 hashes are persisted.
--   - All timestamps are stored as ISO-8601 UTC strings (YYYY-MM-DDTHH:MM:SSZ).
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. TABLE: signing_keys
-- Metadata for asymmetric Ed25519 keys used to sign offline entitlement leases.
-- Private keys live ONLY in Cloudflare Secrets; D1 stores public key metadata
-- and key rotation status.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signing_keys (
    kid                 TEXT PRIMARY KEY,                       -- e.g. 'sspro-ed25519-2026-01'
    algorithm           TEXT NOT NULL DEFAULT 'Ed25519'
                        CHECK (algorithm IN ('Ed25519')),
    public_key_base64   TEXT NOT NULL,                          -- 32-byte raw public key in base64
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
    id                  TEXT PRIMARY KEY,                       -- ULID, e.g. 'adm_01JDF...'
    name                TEXT NOT NULL,                          -- e.g. 'Primary Backoffice Admin'
    key_prefix          TEXT NOT NULL UNIQUE,                   -- e.g. 'ssadm_01JDF8W2'
    key_hash            TEXT NOT NULL UNIQUE,                   -- HMAC-SHA256(ADMIN_TOKEN_PEPPER, secret)
    role                TEXT NOT NULL
                        CHECK (role IN ('super_admin', 'support_admin', 'billing_system', 'read_only')),
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'revoked')),
    allowed_ips_json    TEXT,                                   -- Optional JSON array of CIDR/IP allowlist
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
    id                      TEXT PRIMARY KEY,                   -- ULID, e.g. 'lic_01JDF...'
    product_id              TEXT NOT NULL DEFAULT 'com.stockstudiopro.desktop'
                            CHECK (product_id = 'com.stockstudiopro.desktop'),

    -- Key identification & cryptographic hash (never plaintext)
    key_prefix              TEXT NOT NULL,                      -- First 10 chars, e.g. 'SSPRO-7K9M'
    key_hash                TEXT NOT NULL UNIQUE,               -- Hex HMAC-SHA256(LICENSE_KEY_PEPPER, normalized_key)
    key_pepper_version      INTEGER NOT NULL DEFAULT 1,

    -- Plan & dual-model classification
    plan_code               TEXT NOT NULL,                      -- e.g. 'lifetime', 'pro_monthly', 'pro_yearly'
    plan_name               TEXT NOT NULL,                      -- e.g. 'Lifetime', '30 Days', '1 Year'
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
    activated_at            TEXT,                               -- Timestamp of first device activation
    current_period_start    TEXT,                               -- NULL for perpetual; ISO-8601 UTC for subscription
    current_period_end      TEXT,                               -- NULL for perpetual; ISO-8601 UTC for subscription
    expires_at              TEXT,                               -- NULL for perpetual; ISO-8601 UTC for subscription
    grace_until             TEXT,                               -- Optional payment retry grace timestamp for past_due subscriptions
    cancel_at_period_end    INTEGER NOT NULL DEFAULT 0
                            CHECK (cancel_at_period_end IN (0, 1)),
    canceled_at             TEXT,

    -- Update & feature entitlements (JSON object)
    updates_until           TEXT,                               -- Optional major-update cutoff for perpetual tiers; NULL = unlimited
    max_app_version         TEXT,                               -- Optional semver cap; NULL = unlimited
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
    id                  TEXT PRIMARY KEY,                       -- Client-generated install UUID v4 (anchored in Windows Credential Manager)
    device_fingerprint  TEXT NOT NULL,                          -- Hex SHA-256 hardware fingerprint hash
    device_name         TEXT NOT NULL,                          -- Sanitized hostname, e.g. 'DESKTOP-STUDIO01'
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
-- Preserves full activation/deactivation history while enforcing at most one
-- active binding per (license_id, device_id) via partial unique index.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activations (
    id                      TEXT PRIMARY KEY,                   -- ULID, e.g. 'act_01JDF...'
    license_id              TEXT NOT NULL
                            REFERENCES licenses(id) ON DELETE RESTRICT,
    device_id               TEXT NOT NULL
                            REFERENCES devices(id) ON DELETE RESTRICT,
    device_fingerprint      TEXT NOT NULL,                      -- Snapshot of fingerprint at activation time
    device_name_snapshot    TEXT NOT NULL,
    app_version_snapshot    TEXT NOT NULL,

    -- Authentication token for validate / deactivate calls (SHA-256 hash only)
    token_prefix            TEXT NOT NULL,                      -- e.g. 'ssact_01JDF8Y5'
    token_hash              TEXT NOT NULL UNIQUE,               -- Hex SHA-256(activation_token)

    -- Current lease metadata
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'deactivated', 'revoked', 'expired')),
    last_lease_jti          TEXT,
    last_lease_issued_at    TEXT NOT NULL,
    last_lease_expires_at   TEXT NOT NULL,

    -- Lifecycle timestamps
    activated_at            TEXT NOT NULL,
    last_validated_at       TEXT NOT NULL,
    last_seen_ip_hash       TEXT,                               -- Privacy-preserving daily salted hash of IP for abuse detection
    deactivated_at          TEXT,
    deactivated_by          TEXT,                               -- 'client_self', 'client_key_owner', 'admin:<id>', 'system_revocation'
    deactivation_reason     TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

-- Enforce that a device_id can only hold ONE active slot on a given license at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_unique_active_device
    ON activations (license_id, device_id)
    WHERE status = 'active';

-- Enforce that a hardware fingerprint can only hold ONE active slot on a given license at any time
-- (Prevents reinstall UUID regeneration from consuming a second device slot on the same machine)
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
-- license. Decouples payment gateway specifics from license entitlement logic.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                          TEXT PRIMARY KEY,               -- ULID, e.g. 'sub_01JDF...'
    license_id                  TEXT NOT NULL UNIQUE
                                REFERENCES licenses(id) ON DELETE RESTRICT,
    provider                    TEXT NOT NULL,                  -- e.g. 'stripe', 'lemonsqueezy', 'paddle', 'midtrans', 'xendit', 'manual'
    external_customer_id        TEXT,
    external_subscription_id    TEXT NOT NULL,
    external_plan_id            TEXT,
    billing_interval            TEXT NOT NULL
                                CHECK (billing_interval IN ('monthly', 'yearly')),
    provider_status             TEXT NOT NULL,                  -- Raw status mapped to canonical ('active', 'past_due', 'canceled', 'unpaid')
    currency                    TEXT,                           -- ISO 4217, e.g. 'IDR', 'USD'
    unit_amount_minor           INTEGER,                        -- Amount in smallest currency unit
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
-- Only confirmed payment events recorded here can extend subscription validity.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_events (
    id                      TEXT PRIMARY KEY,                   -- ULID, e.g. 'bev_01JDF...'
    provider                TEXT NOT NULL,                      -- e.g. 'stripe', 'midtrans', 'manual'
    provider_event_id       TEXT NOT NULL,                      -- Unique webhook/transaction ID from provider
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
    payload_sha256          TEXT NOT NULL,                      -- SHA-256 of raw webhook body for forensic verification
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
    id                  TEXT PRIMARY KEY,                       -- ULID, e.g. 'lev_01JDF...'
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
    actor_id            TEXT,                                   -- device_id, admin_api_key.id, or provider name
    previous_status     TEXT,
    new_status          TEXT,
    ip_hash             TEXT,
    user_agent          TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',             -- Structured context (never contains raw license keys or secrets)
    created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_events_license_created
    ON license_events (license_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_license_events_type_created
    ON license_events (event_type, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. TABLE: rate_limit_buckets
-- Lightweight D1 fallback/persistent lockout counter for repeated failed key
-- attempts per key_prefix or IP hash.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key          TEXT PRIMARY KEY,                       -- e.g. 'act_ip:<sha256>' or 'act_prefix:SSPRO-7K9M'
    window_start        INTEGER NOT NULL,                       -- Epoch seconds aligned to window
    attempt_count       INTEGER NOT NULL DEFAULT 1,
    locked_until        INTEGER,                                -- Epoch seconds if temporarily locked out
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_updated
    ON rate_limit_buckets (updated_at);
