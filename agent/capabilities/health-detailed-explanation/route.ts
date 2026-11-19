import { readBoundedRequestBody } from '../../../lib/bounded-request-body.ts';
import type { DetailedExplanationHandlerResult } from './handler.ts';
import type { DetailedExplanationOutput } from './schema.ts';
import { verifyHealthServiceAuthorization } from './service-auth.ts';

type HttpResult = {
  statusCode: 200 | 400 | 401 | 409 | 413 | 422 | 500 | 503;
  body: { ok: true; data: DetailedExplanationOutput }
    | { ok: false; code: string };
};

const statusByCode = {
  DETAILED_EXPLANATION_REQUEST_REJECTED: 400,
  DETAILED_EXPLANATION_DUPLICATE: 409,
  DETAILED_EXPLANATION_IDEMPOTENCY_CONFLICT: 409,
  DETAILED_EXPLANATION_TEMPORARY_FAILURE: 503,
  DETAILED_EXPLANATION_OUTPUT_REJECTED: 422,
} as const satisfies Record<Exclude<DetailedExplanationHandlerResult, { ok: true }>['code'], HttpResult['statusCode']>;

export const DETAILED_EXPLANATION_MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function readDetailedExplanationBody(stream: AsyncIterable<Uint8Array | string> & { body?: unknown }, maxBytes = DETAILED_EXPLANATION_MAX_BODY_BYTES) {
  const result = await readBoundedRequestBody(stream, maxBytes);
  return result.ok ? result : { ok: false as const, code: result.reason === 'too_large'
    ? 'DETAILED_EXPLANATION_PAYLOAD_TOO_LARGE' as const : 'DETAILED_EXPLANATION_REQUEST_BODY_ERROR' as const };
}

export async function handleDetailedExplanationHttpRequest(input: {
  authorization: string | undefined;
  bodyText: string;
  serviceToken?: string;
  handler: (capsule: unknown) => Promise<DetailedExplanationHandlerResult>;
}): Promise<HttpResult> {
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) {
    return { statusCode: 401, body: { ok: false, code: 'DETAILED_EXPLANATION_UNAUTHORIZED' } };
  }

  let capsule: unknown;
  try {
    capsule = JSON.parse(input.bodyText);
  } catch {
    return { statusCode: 400, body: { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' } };
  }

  const result = await input.handler(capsule);
  if (result.ok) return { statusCode: 200, body: { ok: true, data: result.output } };
  return { statusCode: statusByCode[result.code], body: { ok: false, code: result.code } };
}
