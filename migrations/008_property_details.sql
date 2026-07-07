-- Postcode for property list display/sort, and connection_date distinct from
-- install_date: install_date is when the hardware went in; connection_date is
-- when the property first completed Fox OAuth linking (set automatically in
-- the OAuth callback, src/routes/oauth.ts) -- a property can be installed for
-- weeks before anyone actually links the Fox account.
ALTER TABLE properties ADD COLUMN postcode TEXT;
ALTER TABLE properties ADD COLUMN connection_date DATE;
