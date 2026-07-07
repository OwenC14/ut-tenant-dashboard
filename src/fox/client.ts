import { env } from '../config/env';

export interface FoxTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// Endpoint paths and response field names below follow Fox's published OAuth2
// docs (spec §4.1) but the public docs page doesn't give a fully explicit
// response schema. Confirm both against Fox's sandbox/Postman collection the
// first time this runs against a real client_id — if field names differ,
// this is the only file that needs to change.
const TOKEN_PATH = '/oauth2/token';
const REFRESH_PATH = '/oauth2/refresh';

function parseTokenResponse(data: Record<string, unknown>): FoxTokens {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = Number(data.expires_in ?? 3600);

  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error(`Unexpected Fox token response shape: ${JSON.stringify(data)}`);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

async function postForm(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(path, env.FOX_DOMAIN);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Fox ${path} returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`Fox ${path} failed (status ${res.status}): ${text.slice(0, 200)}`);
  }

  return data as Record<string, unknown>;
}

export function buildAuthorizeUrl(state: string): string {
  const url = new URL('/h5/auth/foxessIndex', env.FOX_DOMAIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.FOX_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.FOX_REDIRECT_URI);
  if (env.FOX_SCOPE) {
    url.searchParams.set('scope', env.FOX_SCOPE);
  }
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForTokens(code: string): Promise<FoxTokens> {
  const data = await postForm(TOKEN_PATH, {
    grant_type: 'authorization_code',
    code,
    client_id: env.FOX_CLIENT_ID,
    client_secret: env.FOX_CLIENT_SECRET,
    redirect_uri: env.FOX_REDIRECT_URI,
  });
  return parseTokenResponse(data);
}

export async function refreshTokens(refreshToken: string): Promise<FoxTokens> {
  const data = await postForm(REFRESH_PATH, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.FOX_CLIENT_ID,
    client_secret: env.FOX_CLIENT_SECRET,
  });
  return parseTokenResponse(data);
}
