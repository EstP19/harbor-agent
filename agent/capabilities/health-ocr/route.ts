import { timingSafeEqual } from 'node:crypto';

import type { HealthOcrHandlerResult } from './handler.ts';

function authorized(authorization: string | undefined, serviceToken: string | undefined): boolean {
  if (!serviceToken) return false;
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(serviceToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleHealthOcrHttpRequest(input: {
  authorization: string | undefined;
  serviceToken: string | undefined;
  bodyText: string;
  handler: (value: unknown) => Promise<HealthOcrHandlerResult>;
}): Promise<{ statusCode: number; body: unknown }> {
  if (!authorized(input.authorization, input.serviceToken)) return { statusCode: 401, body: { ok: false, code: 'HEALTH_OCR_UNAUTHORIZED' } };
  let body: unknown;
  try { body = JSON.parse(input.bodyText); }
  catch { return { statusCode: 400, body: { ok: false, code: 'HEALTH_OCR_INVALID_JSON' } }; }
  const result = await input.handler(body);
  if (result.ok) return { statusCode: 200, body: { ok: true, data: result.output } };
  const statusCode = result.code === 'HEALTH_OCR_TEMPORARY_FAILURE' ? 503 : 422;
  return { statusCode, body: { ok: false, code: result.code } };
}
