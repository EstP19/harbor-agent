import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import { handleImagingKbAnalysis } from './handler.ts';

export async function handleImagingKbAnalysisHttp(input: {
  authorization: string | undefined; body: unknown;
  completion: Parameters<typeof handleImagingKbAnalysis>[1];
}) {
  if (!verifyHealthServiceAuthorization(input.authorization)) return { statusCode: 401, body: { ok: false, code: 'IMAGING_KB_ANALYSIS_UNAUTHORIZED' } };
  const body = await handleImagingKbAnalysis(input.body, input.completion);
  return { statusCode: body.ok ? 200 : body.code === 'IMAGING_KB_ANALYSIS_UNAVAILABLE' ? 503 : 422, body };
}
