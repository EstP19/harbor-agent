import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import {
  handleHealthImagingExplanationRequest,
  type HealthImagingExplanationCompletion,
  type HealthImagingExplanationHandlerResult,
} from './handler.ts';

export type HealthImagingExplanationHttpResult = {
  statusCode: 200 | 400 | 401 | 422 | 503;
  body: Record<string, unknown>;
};

export async function handleHealthImagingExplanationHttpRequest(input: {
  authorization: string | undefined;
  serviceToken?: string;
  bodyText: string;
  traceId?: string;
  completion?: HealthImagingExplanationCompletion;
}): Promise<HealthImagingExplanationHttpResult> {
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) {
    return { statusCode: 401, body: { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_UNAUTHORIZED' } };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.bodyText);
  } catch {
    return { statusCode: 400, body: { ok: false, code: 'HEALTH_IMAGING_EXPLANATION_REQUEST_REJECTED' } };
  }

  const result = await handleHealthImagingExplanationRequest(body, {
    completion: input.completion,
  });

  if (result.ok) {
    return { statusCode: 200, body: result };
  }

  if (result.code === 'HEALTH_IMAGING_EXPLANATION_NO_MATCH') {
    return { statusCode: 200, body: result };
  }

  return { statusCode: 400, body: result };
}
