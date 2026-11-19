import { query } from './db.ts';

export interface AgentRequestDTO {
  sessionId?: string;
  userId?: string;
  capabilityCode: string;
  idempotencyKey: string;
}

export interface AgentRunDTO {
  requestId: string;
  attemptNumber?: number;
}

/**
 * Registra o recupera una sesión activa en agent_core.sessions
 */
export async function ensureAgentSession(userId: string, existingSessionId?: string): Promise<string> {
  if (existingSessionId) {
    try {
      const res = await query(
        `SELECT session_id FROM agent_core.sessions WHERE session_id = $1 AND status = 'active'`,
        [existingSessionId]
      );
      if (res.rows.length > 0) {
        return res.rows[0].session_id;
      }
    } catch (e) {}
  }

  try {
    // Upsert de usuario en iam.users para evitar fallo de FK en sessions_user_id_fkey
    await query(
      `INSERT INTO iam.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const res = await query(
      `INSERT INTO agent_core.sessions (user_id, status) VALUES ($1, 'active') RETURNING session_id`,
      [userId]
    );
    return res.rows[0].session_id;
  } catch (err: any) {
    console.warn(`[agent-service] ⚠️ No se pudo registrar sesión en PostgreSQL (${err?.message || err}). Usando session_id temporal.`);
    return `session_temp_${Date.now()}`;
  }
}

/**
 * Registra una solicitud idempotente en agent_core.requests
 */
export async function createAgentRequest(dto: AgentRequestDTO): Promise<{ requestId: string; isDuplicate: boolean }> {
  const userId = dto.userId || '00000000-0000-0000-0000-000000000001';
  const sessionId = await ensureAgentSession(userId, dto.sessionId);

  try {
    // Comprobar idempotencia previa
    const checkRes = await query(
      `SELECT request_id, status FROM agent_core.requests WHERE session_id = $1 AND idempotency_key = $2`,
      [sessionId, dto.idempotencyKey]
    );

    if (checkRes.rows.length > 0) {
      return { requestId: checkRes.rows[0].request_id, isDuplicate: true };
    }

    // Asegurar que la capacidad esté registrada en agent_core.capabilities
    try {
      await query(
        `INSERT INTO agent_core.capabilities (capability_code, enabled, description)
         VALUES ($1, true, 'Auto-registered capability')
         ON CONFLICT (capability_code) DO NOTHING`,
        [dto.capabilityCode]
      );
    } catch (e) {}

    const insertRes = await query(
      `INSERT INTO agent_core.requests (session_id, capability_code, idempotency_key, status)
       VALUES ($1, $2, $3, 'running') RETURNING request_id`,
      [sessionId, dto.capabilityCode, dto.idempotencyKey]
    );

    return { requestId: insertRes.rows[0].request_id, isDuplicate: false };
  } catch (dbErr: any) {
    console.warn(`[agent-service] ⚠️ Error registrando request en DB (${dbErr?.message}). Usando requestId temporal.`);
    return { requestId: `req_temp_${Date.now()}`, isDuplicate: false };
  }
}

/**
 * Crea la ejecución (Run) asociada a la solicitud en agent_core.runs
 */
export async function createAgentRun(dto: AgentRunDTO): Promise<string> {
  if (dto.requestId.startsWith('req_temp_')) {
    return `run_temp_${Date.now()}`;
  }
  const attempt = dto.attemptNumber || 1;
  try {
    const res = await query(
      `INSERT INTO agent_core.runs (request_id, attempt_number, status)
       VALUES ($1, $2, 'running') RETURNING run_id`,
      [dto.requestId, attempt]
    );
    return res.rows[0].run_id;
  } catch (err: any) {
    console.warn(`[agent-service] ⚠️ Error registrando run en DB (${err?.message}). Usando runId temporal.`);
    return `run_temp_${Date.now()}`;
  }
}

/**
 * Actualiza el estado final de un Run y su Request
 */
export async function finishAgentRun(runId: string, requestId: string, status: 'completed' | 'failed' | 'blocked'): Promise<void> {
  if (runId.startsWith('run_temp_') || requestId.startsWith('req_temp_')) {
    return;
  }
  try {
    await query(
      `UPDATE agent_core.runs SET status = $1, finished_at = clock_timestamp() WHERE run_id = $2`,
      [status, runId]
    );
    await query(
      `UPDATE agent_core.requests SET status = $1 WHERE request_id = $2`,
      [status, requestId]
    );
  } catch (err: any) {
    console.warn(`[agent-service] ⚠️ Error actualizando estado de run/request en DB:`, err?.message);
  }
}

/**
 * Registra el resultado de un Guardrail de seguridad en agent_core.guardrail_results
 */
export async function recordGuardrailResult(runId: string, guardrailCode: string, passed: boolean, details: object = {}): Promise<void> {
  if (runId.startsWith('run_temp_')) {
    return;
  }
  try {
    await query(
      `INSERT INTO agent_core.guardrail_results (run_id, guardrail_code, passed, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, guardrail_code) DO UPDATE SET passed = EXCLUDED.passed, details = EXCLUDED.details`,
      [runId, guardrailCode, passed, JSON.stringify(details)]
    );
  } catch (err: any) {
    console.warn(`[agent-service] ⚠️ Error guardando guardrail en DB:`, err?.message);
  }
}
