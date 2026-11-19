import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import type { DoctorQuestionsHandlerResult } from './handler.ts';
import { readBoundedRequestBody } from '../../../lib/bounded-request-body.ts';

export const DOCTOR_QUESTIONS_MAX_BODY_BYTES = 128 * 1024;
export async function readDoctorQuestionsBody(stream: AsyncIterable<Uint8Array | string> & { body?: unknown }, maxBytes = DOCTOR_QUESTIONS_MAX_BODY_BYTES) {
  const result = await readBoundedRequestBody(stream, maxBytes);
  return result.ok ? result : { ok: false as const, code: result.reason === 'too_large'
    ? 'DOCTOR_QUESTIONS_PAYLOAD_TOO_LARGE' as const : 'DOCTOR_QUESTIONS_BODY_ERROR' as const };
}

const statuses = { DOCTOR_QUESTIONS_REQUEST_REJECTED: 400, DOCTOR_QUESTIONS_DUPLICATE: 409, DOCTOR_QUESTIONS_CONFLICT: 409, DOCTOR_QUESTIONS_TEMPORARY_FAILURE: 503, DOCTOR_QUESTIONS_OUTPUT_REJECTED: 422 } as const;
export async function handleDoctorQuestionsHttpRequest(input: { authorization?: string; serviceToken?: string; bodyText: string; handler: (value: unknown) => Promise<DoctorQuestionsHandlerResult> }) {
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) return { statusCode: 401, body: { ok: false, code: 'DOCTOR_QUESTIONS_UNAUTHORIZED' } };
  let value: unknown; try { value = JSON.parse(input.bodyText); } catch { return { statusCode: 400, body: { ok: false, code: 'DOCTOR_QUESTIONS_REQUEST_REJECTED' } }; }
  const result = await input.handler(value);
  return result.ok ? { statusCode: 200, body: { ok: true, data: result.output } } : { statusCode: statuses[result.code], body: { ok: false, code: result.code } };
}
