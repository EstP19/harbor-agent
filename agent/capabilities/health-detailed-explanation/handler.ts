import { validateDetailedExplanationOutput } from './guardrails.ts';
import { buildDetailedExplanationPrompt } from './prompt.ts';
import {
  createDetailedExplanationRequestHash,
  type DetailedExplanationReservation,
} from './reservation.ts';
import {
  detailedExplanationCapsuleSchema,
  type DetailedExplanationOutput,
} from './schema.ts';

export type DetailedExplanationCode =
  | 'DETAILED_EXPLANATION_REQUEST_REJECTED'
  | 'DETAILED_EXPLANATION_DUPLICATE'
  | 'DETAILED_EXPLANATION_IDEMPOTENCY_CONFLICT'
  | 'DETAILED_EXPLANATION_TEMPORARY_FAILURE'
  | 'DETAILED_EXPLANATION_OUTPUT_REJECTED';

export type DetailedExplanationHandlerResult =
  | { ok: true; output: DetailedExplanationOutput }
  | { ok: false; code: DetailedExplanationCode };

export interface DetailedExplanationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface DetailedExplanationEvidence {
  record(event: {
    requestId: string;
    itemId: string;
    contractVersion: string;
    capabilityVersion: string;
    status: 'completed' | 'rejected' | 'duplicate' | 'conflict' | 'temporary_failure' | 'output_rejected';
    durationMs: number;
  }): Promise<void> | void;
}

export interface DetailedExplanationCompletion {
  (prompt: { systemPrompt: string; userPrompt: string }, signal: AbortSignal): Promise<unknown>;
}

interface HandlerDependencies {
  completion: DetailedExplanationCompletion;
  reservation: DetailedExplanationReservation;
  clock: DetailedExplanationClock;
  evidence: DetailedExplanationEvidence;
  timeoutMs: number;
}

class TimeoutError extends Error {}

async function completeWithTimeout(
  completion: DetailedExplanationCompletion,
  prompt: { systemPrompt: string; userPrompt: string },
  clock: DetailedExplanationClock,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const pending = completion(prompt, controller.signal);
  const timer = clock.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const result = await pending;
    if (timedOut) throw new TimeoutError();
    return result;
  } catch (error) {
    if (timedOut) throw new TimeoutError();
    throw error;
  } finally {
    clock.clearTimeout(timer);
  }
}

export function createDetailedExplanationHandler(dependencies: HandlerDependencies) {
  return async (capsuleInput: unknown): Promise<DetailedExplanationHandlerResult> => {
    const capsuleResult = detailedExplanationCapsuleSchema.safeParse(capsuleInput);
    if (!capsuleResult.success) return { ok: false, code: 'DETAILED_EXPLANATION_REQUEST_REJECTED' };

    const capsule = capsuleResult.data;
    const startedAt = dependencies.clock.now();
    const evidence = async (status: Parameters<DetailedExplanationEvidence['record']>[0]['status']) => {
      await dependencies.evidence.record({
        requestId: capsule.requestId,
        itemId: capsule.itemId,
        contractVersion: capsule.contractVersion,
        capabilityVersion: 'health-detailed-explanation-capability/v1',
        status,
        durationMs: Math.max(0, dependencies.clock.now() - startedAt),
      });
    };

    try {
      const reservation = await dependencies.reservation.claim({
        idempotencyKey: capsule.idempotencyKey,
        requestHash: createDetailedExplanationRequestHash(capsule),
      });
      if (reservation.kind === 'duplicate') {
        try { await evidence('duplicate'); } catch {}
        if (reservation.status === 'completed') {
          const replay = validateDetailedExplanationOutput(capsule, reservation.output);
          return replay.ok ? { ok: true, output: replay.value } : { ok: false, code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE' };
        }
        return { ok: false, code: 'DETAILED_EXPLANATION_DUPLICATE' };
      }
      if (reservation.kind === 'conflict') {
        await evidence('conflict');
        return { ok: false, code: 'DETAILED_EXPLANATION_IDEMPOTENCY_CONFLICT' };
      }
      const claimToken = reservation.claimToken;

      let providerOutput: unknown;
      try {
        providerOutput = await completeWithTimeout(
          dependencies.completion,
          buildDetailedExplanationPrompt(capsule),
          dependencies.clock,
          dependencies.timeoutMs,
        );
      } catch {
        try { await dependencies.reservation.finalize({ idempotencyKey: capsule.idempotencyKey, requestHash: createDetailedExplanationRequestHash(capsule), claimToken, status: 'failed' }); } catch {}
        try { await evidence('temporary_failure'); } catch {}
        return { ok: false, code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE' };
      }

      const validation = validateDetailedExplanationOutput(capsule, providerOutput);
      if (!validation.ok) {
        try { await dependencies.reservation.finalize({ idempotencyKey: capsule.idempotencyKey, requestHash: createDetailedExplanationRequestHash(capsule), claimToken, status: 'rejected' }); } catch {}
        try { await evidence('output_rejected'); } catch {}
        return { ok: false, code: 'DETAILED_EXPLANATION_OUTPUT_REJECTED' };
      }

      try {
        await dependencies.reservation.finalize({ idempotencyKey: capsule.idempotencyKey, requestHash: createDetailedExplanationRequestHash(capsule), claimToken, status: 'completed', output: validation.value });
      } catch {
        return { ok: false, code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE' };
      }
      try { await evidence('completed'); } catch {}
      return { ok: true, output: validation.value };
    } catch {
      try { await evidence('temporary_failure'); } catch {}
      return { ok: false, code: 'DETAILED_EXPLANATION_TEMPORARY_FAILURE' };
    }
  };
}
