import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_URL: required('DATABASE_URL'),
  ENCRYPTION_KEY: required('ENCRYPTION_KEY'),
  FOX_DOMAIN: process.env.FOX_DOMAIN ?? 'https://www.foxesscloud.com',
  FOX_CLIENT_ID: required('FOX_CLIENT_ID'),
  FOX_CLIENT_SECRET: required('FOX_CLIENT_SECRET'),
  FOX_REDIRECT_URI: required('FOX_REDIRECT_URI'),
  FOX_SCOPE: process.env.FOX_SCOPE ?? '',
  APP_BASE_URL: process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  ADMIN_API_KEY: required('ADMIN_API_KEY'),
};
