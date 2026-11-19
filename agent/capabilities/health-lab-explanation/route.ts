import { verifyHealthServiceAuthorization } from '../health-detailed-explanation/service-auth.ts';
import {
  handleHealthLabExplanationRequest,
} from './handler.ts';

export type HealthLabExplanationHttpResult = {
  statusCode: 200 | 400 | 401 | 422 | 503;
  body: Record<string, unknown>;
};

export type HealthLabExplanationDiagnosticEvent = {
  traceId: string;
  stage: 'request_received' | 'ai_kb_matching' | 'deterministic_kb_seal';
  outcome: 'started' | 'accepted' | 'failed' | 'unauthorized' | 'request_rejected' | 'output_rejected';
  mode: 'deterministic_kb_seal';
  aiProviderInvoked: boolean;
  geminiConfigured: boolean;
  openAiConfigured: boolean;
  httpStatus?: number;
  code?: string;
  provider?: 'deterministic';
};

type DiagnosticLogger = (event: HealthLabExplanationDiagnosticEvent) => void;

function safeTraceId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : 'untracked';
}

function defaultLogger(event: HealthLabExplanationDiagnosticEvent): void {
  console.info('[harbor-agent:health-lab-explanation]', JSON.stringify(event));
}

export async function handleHealthLabExplanationHttpRequest(input: {
  authorization: string | undefined;
  serviceToken?: string;
  bodyText: string;
  traceId?: string;
  logger?: DiagnosticLogger;
}): Promise<HealthLabExplanationHttpResult> {
  const traceId = safeTraceId(input.traceId);
  const logger = input.logger ?? defaultLogger;
  const aiProviderInvoked = false;
  const emit = (event: Omit<HealthLabExplanationDiagnosticEvent, 'traceId' | 'mode' | 'aiProviderInvoked' | 'geminiConfigured' | 'openAiConfigured'>) => {
    try {
      logger({
        traceId,
        mode: 'deterministic_kb_seal',
        aiProviderInvoked,
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
        ...event,
      });
    } catch { /* diagnostics must never alter the sealed response */ }
  };
  emit({ stage: 'request_received', outcome: 'started' });
  if (!verifyHealthServiceAuthorization(input.authorization, input.serviceToken)) {
    emit({ stage: 'deterministic_kb_seal', outcome: 'unauthorized', httpStatus: 401, code: 'HEALTH_LAB_EXPLANATION_UNAUTHORIZED' });
    return { statusCode: 401, body: { ok: false, code: 'HEALTH_LAB_EXPLANATION_UNAUTHORIZED' } };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.bodyText);
  } catch {
    emit({ stage: 'deterministic_kb_seal', outcome: 'request_rejected', httpStatus: 400, code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' });
    return { statusCode: 400, body: { ok: false, code: 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED' } };
  }

  const result = await handleHealthLabExplanationRequest(body);
  if (result.ok) {
    emit({ stage: 'deterministic_kb_seal', outcome: 'accepted', httpStatus: 200, provider: 'deterministic' });
    return { statusCode: 200, body: result };
  }
  const statusCode = result.code === 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED'
    ? 400
    : 422;
  emit({
    stage: 'deterministic_kb_seal',
    outcome: result.code === 'HEALTH_LAB_EXPLANATION_REQUEST_REJECTED'
      ? 'request_rejected'
      : 'output_rejected',
    httpStatus: statusCode,
    code: result.code,
  });
  return {
    statusCode,
    body: result,
  };
}
