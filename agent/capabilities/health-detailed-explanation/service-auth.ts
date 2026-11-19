import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function verifyHealthServiceAuthorization(
  authorization: string | undefined,
  configuredToken = process.env.HARBOR_HEALTH_SERVICE_TOKEN,
): boolean {
  if (!configuredToken || configuredToken.trim().length === 0) return false;
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
  return timingSafeEqual(digest(token), digest(configuredToken));
}
