-- Configurable tariff rates (spec §5, §4) — Ofgem's price cap changes
-- quarterly, so rates are versioned by effective_from rather than hardcoded.
-- The rollup job picks the most recent row with effective_from <= the date
-- being rolled up, so historical rollups keep using the rate that was live
-- at the time even after a new quarter's row is inserted.
CREATE TABLE tariff_rates (
  id BIGSERIAL PRIMARY KEY,
  effective_from DATE NOT NULL UNIQUE,
  grid_cap_rate_p_per_kwh NUMERIC(6,3) NOT NULL,
  offpeak_rate_p_per_kwh NUMERIC(6,3) NOT NULL,
  standing_charge_p_per_day NUMERIC(6,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with the rates in UT_Phase1_Tenant_Calculator.html (Ofgem Direct Debit
-- price cap, Jul-Sep 2026) so the rollup job works before anyone updates it.
INSERT INTO tariff_rates (effective_from, grid_cap_rate_p_per_kwh, offpeak_rate_p_per_kwh, standing_charge_p_per_day)
VALUES ('2026-07-01', 26.11, 8.0, 57.19);
