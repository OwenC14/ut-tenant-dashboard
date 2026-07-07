-- Tenant self-signup (replaces admin manually typing in tenant_email as the
-- only path). Install staff hand the tenant this code on their welcome
-- paperwork; the tenant claims their own property with it + their email.
ALTER TABLE properties ADD COLUMN signup_code TEXT;
CREATE UNIQUE INDEX idx_properties_signup_code ON properties (signup_code) WHERE signup_code IS NOT NULL;
