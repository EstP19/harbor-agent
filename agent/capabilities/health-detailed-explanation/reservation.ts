import { createHash, randomUUID } from 'node:crypto';

import type { DetailedExplanationCapsule, DetailedExplanationOutput } from './schema.ts';

const CAPABILITY_CODE = 'health_detailed_explanation';

export type ReservationResult =
  | { kind: 'claimed'; claimToken: string }
  | { kind: 'duplicate'; status: 'running' }
  | { kind: 'duplicate'; status: 'completed'; output: unknown }
  | { kind: 'conflict' };

type FinalizeReservationInput = {
  idempotencyKey: string;
  requestHash: string;
  claimToken: string;
} & ({ status: 'completed'; output: DetailedExplanationOutput } | { status: 'failed' | 'rejected'; output?: never });

export interface DetailedExplanationReservation {
  claim(input: { idempotencyKey: string; requestHash: string }): Promise<ReservationResult>;
  finalize(input: FinalizeReservationInput): Promise<void>;
}

interface QueryExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

interface ReservationRow {
  outcome: ReservationResult['kind'];
  claim_token?: string;
  status?: 'running' | 'completed';
  response_json?: unknown;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createDetailedExplanationRequestHash(capsule: DetailedExplanationCapsule): string {
  return createHash('sha256').update(canonicalize(capsule), 'utf8').digest('hex');
}

export class PostgresDetailedExplanationReservation implements DetailedExplanationReservation {
  private readonly database: QueryExecutor;

  constructor(database: QueryExecutor) {
    this.database = database;
  }

  async claim(input: { idempotencyKey: string; requestHash: string }): Promise<ReservationResult> {
    const claimToken = randomUUID();
    const result = await this.database.query(
      `SELECT o_outcome AS outcome, o_claim_token AS claim_token, o_status AS status, o_response_json AS response_json FROM agent_core.claim_capability_reservation($1, $2, $3, $4, $5)`,
      [CAPABILITY_CODE, input.idempotencyKey, input.requestHash, claimToken, 90_000],
    );

    const row = result.rows[0] as ReservationRow | undefined;
    if (!row || !['claimed', 'duplicate', 'conflict'].includes(row.outcome)) {
      throw new Error('detailed explanation reservation did not return an atomic outcome');
    }
    if (row.outcome === 'claimed' && typeof row.claim_token === 'string') return { kind: 'claimed', claimToken: row.claim_token };
    if (row.outcome === 'duplicate' && row.status === 'running') return { kind: 'duplicate', status: 'running' };
    if (row.outcome === 'duplicate' && row.status === 'completed' && row.response_json !== null && row.response_json !== undefined) return { kind: 'duplicate', status: 'completed', output: row.response_json };
    if (row.outcome === 'conflict') return { kind: 'conflict' };
    throw new Error('detailed explanation reservation returned an invalid lifecycle outcome');
  }

  async finalize(input: FinalizeReservationInput): Promise<void> {
    const result = await this.database.query(
      `SELECT agent_core.finalize_capability_reservation($1, $2, $3, $4, $5, $6::jsonb) AS finalized`,
      [CAPABILITY_CODE, input.idempotencyKey, input.requestHash, input.claimToken, input.status, input.status === 'completed' ? input.output : null],
    );
    if (result.rows.length !== 1 || (result.rows[0] as { finalized?: unknown }).finalized !== true) throw new Error('detailed explanation reservation lease was lost');
  }
}
