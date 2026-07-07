import { pool } from '../db/pool';

export type AgreementType = 'app_terms' | 'ha_data_sharing';
export type ConsentDecision = 'accepted' | 'declined' | 'withdrawn';

export interface Agreement {
  id: number;
  type: AgreementType;
  version: number;
  documentTextOrUrl: string;
  effectiveFrom: string;
}

export async function getCurrentAgreement(type: AgreementType): Promise<Agreement | null> {
  const { rows } = await pool.query(
    `SELECT id, type, version, document_text_or_url, effective_from
     FROM agreements
     WHERE type = $1 AND effective_from <= now()
     ORDER BY version DESC LIMIT 1`,
    [type]
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    type: rows[0].type,
    version: rows[0].version,
    documentTextOrUrl: rows[0].document_text_or_url,
    effectiveFrom: rows[0].effective_from,
  };
}

export interface ConsentStatus {
  agreementId: number;
  version: number;
  documentTextOrUrl: string;
  status: ConsentDecision | null; // null = never decided for THIS version
  recordedAt: string | null;
}

// Spec §9a.4 points 3 and 5: status is scoped to the current agreement
// version specifically. If the version has just changed, any consent row
// tied to the old agreement_id doesn't match this query, so status comes
// back null (not "accepted") and the tenant is re-prompted automatically —
// no separate "has this version changed" check needed.
export async function getCurrentConsentStatus(propertyId: number, type: AgreementType): Promise<ConsentStatus | null> {
  const agreement = await getCurrentAgreement(type);
  if (!agreement) return null;

  const { rows } = await pool.query(
    `SELECT status, recorded_at
     FROM consent_records
     WHERE property_id = $1 AND agreement_id = $2
     ORDER BY recorded_at DESC LIMIT 1`,
    [propertyId, agreement.id]
  );

  return {
    agreementId: agreement.id,
    version: agreement.version,
    documentTextOrUrl: agreement.documentTextOrUrl,
    status: rows[0]?.status ?? null,
    recordedAt: rows[0]?.recorded_at ?? null,
  };
}

// Append-only (spec §9a.4): every call inserts a new row, never updates one,
// so the full accept/decline/withdraw history stays intact for audit.
export async function recordConsent(
  propertyId: number,
  agreementId: number,
  status: ConsentDecision,
  meta: { recordedBy?: string; ipAddress?: string; userAgent?: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO consent_records (property_id, agreement_id, status, recorded_by, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [propertyId, agreementId, status, meta.recordedBy ?? null, meta.ipAddress ?? null, meta.userAgent ?? null]
  );
}
