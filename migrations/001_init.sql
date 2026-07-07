-- Pilot-scope schema (spec §5). HA/LA portfolio tables (organizations,
-- organization_users, agreements, consent_records — spec §9a) are deliberately
-- deferred to build-order steps 8-9 (§10), after the tenant dashboard is proven.

CREATE TABLE properties (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  ha_or_la_partner TEXT,
  fox_device_sn TEXT NOT NULL UNIQUE,
  fox_access_token TEXT,
  fox_refresh_token TEXT,
  fox_token_expires_at TIMESTAMPTZ,
  install_date DATE,
  array_size_kwp NUMERIC(6,2),
  battery_capacity_kwh NUMERIC(6,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meter_readings (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reading_time TIMESTAMPTZ NOT NULL,
  generation_kwh NUMERIC(10,3),
  feedin_kwh NUMERIC(10,3),
  grid_import_kwh NUMERIC(10,3),
  battery_charge_kwh NUMERIC(10,3),
  battery_discharge_kwh NUMERIC(10,3),
  loads_kwh NUMERIC(10,3),
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meter_readings_property_time ON meter_readings (property_id, reading_time);

CREATE TABLE daily_rollups (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  solar_self_consumed_kwh NUMERIC(10,3),
  battery_covered_kwh NUMERIC(10,3),
  grid_covered_kwh NUMERIC(10,3),
  estimated_cost_current_bill NUMERIC(10,2),
  estimated_cost_new_bill NUMERIC(10,2),
  estimated_saving NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, date)
);

CREATE INDEX idx_daily_rollups_property_date ON daily_rollups (property_id, date);
