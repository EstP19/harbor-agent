import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import { handleLabKbAnalysis, type LabKbAnalysisCompletion } from './handler.ts';

export async function handleLabKbAnalysisHttp(input: { authorization?: string; serviceToken?: string;
  body: unknown; completion: LabKbAnalysisCompletion }) {
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) {
    return { statusCode: 401, body: { ok: false, code: 'LAB_KB_ANALYSIS_UNAUTHORIZED' } };
  }
  const body = await handleLabKbAnalysis(input.body, input.completion);
  return { statusCode: body.ok ? 200 : body.code === 'LAB_KB_ANALYSIS_UNAVAILABLE' ? 503 : 422, body };
}
