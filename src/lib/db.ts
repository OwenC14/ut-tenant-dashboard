export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function uniqueViolationConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { constraint?: string }).constraint : undefined;
}
