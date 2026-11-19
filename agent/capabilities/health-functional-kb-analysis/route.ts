import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import { handleFunctionalKbAnalysis, type FunctionalKbAnalysisCompletion } from './handler.ts';

export async function handleFunctionalKbAnalysisHttp(input: {
  authorization: string | undefined;
  serviceToken?: string;
  body: unknown;
  completion: FunctionalKbAnalysisCompletion;
}) {
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) {
    return { statusCode: 401, body: { ok: false, code: 'FUNCTIONAL_KB_ANALYSIS_UNAUTHORIZED' } };
  }
  const body = await handleFunctionalKbAnalysis(input.body, input.completion);
  return {
    statusCode: body.ok ? 200 : body.code === 'FUNCTIONAL_KB_ANALYSIS_UNAVAILABLE' ? 503 : 422,
    body,
  };
}
