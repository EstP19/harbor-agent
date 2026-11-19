import { createHash, randomUUID } from 'node:crypto';
import type { DoctorQuestionsCapsule, DoctorQuestionsOutput } from './schema.ts';

const CAPABILITY_CODE = 'health_doctor_questions';
export type DoctorQuestionsReservationResult =
  | { kind: 'claimed'; claimToken: string }
  | { kind: 'duplicate'; status: 'running' }
  | { kind: 'duplicate'; status: 'completed'; output: unknown }
  | { kind: 'conflict' };

export interface DoctorQuestionsReservation {
  claim(input: { idempotencyKey: string; requestHash: string }): Promise<DoctorQuestionsReservationResult>;
  finalize(input: { idempotencyKey: string; requestHash: string; claimToken: string; status: 'completed' | 'failed' | 'rejected'; output?: DoctorQuestionsOutput }, signal: AbortSignal): Promise<void>;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createDoctorQuestionsRequestHash(capsule: DoctorQuestionsCapsule): string {
  return createHash('sha256').update(canonicalize(capsule), 'utf8').digest('hex');
}

interface QueryExecutor { query(text: string, values: unknown[], signal?: AbortSignal): Promise<{ rows: unknown[] }>; }

export class PostgresDoctorQuestionsReservation implements DoctorQuestionsReservation {
  private readonly database: QueryExecutor;
  constructor(database: QueryExecutor) { this.database = database; }
  async claim(input: { idempotencyKey: string; requestHash: string }): Promise<DoctorQuestionsReservationResult> {
    const token = randomUUID();
    const result = await this.database.query(
      'SELECT o_outcome AS outcome,o_claim_token AS claim_token,o_status AS status,o_response_json AS response_json FROM agent_core.claim_capability_reservation($1,$2,$3,$4,$5)',
      [CAPABILITY_CODE, input.idempotencyKey, input.requestHash, token, 90_000],
    );
    const row = result.rows[0] as { outcome?: string; claim_token?: string; status?: string; response_json?: unknown } | undefined;
    if (row?.outcome === 'claimed' && row.claim_token) return { kind: 'claimed', claimToken: row.claim_token };
    if (row?.outcome === 'duplicate' && row.status === 'running') return { kind: 'duplicate', status: 'running' };
    if (row?.outcome === 'duplicate' && row.status === 'completed') return { kind: 'duplicate', status: 'completed', output: row.response_json };
    if (row?.outcome === 'conflict') return { kind: 'conflict' };
    throw new Error('doctor questions reservation invalid outcome');
  }
  async finalize(input: { idempotencyKey: string; requestHash: string; claimToken: string; status: 'completed' | 'failed' | 'rejected'; output?: DoctorQuestionsOutput }, signal: AbortSignal): Promise<void> {
    const result = await this.database.query(
      'SELECT agent_core.finalize_capability_reservation($1,$2,$3,$4,$5,$6::jsonb) AS finalized',
      [CAPABILITY_CODE, input.idempotencyKey, input.requestHash, input.claimToken, input.status, input.status === 'completed' ? input.output : null],
      signal,
    );
    if ((result.rows[0] as { finalized?: unknown } | undefined)?.finalized !== true) throw new Error('doctor questions reservation lease lost');
  }
}
