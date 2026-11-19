import { z } from 'zod';

const inputSchema = z.object({
  contractVersion: z.literal('health-ocr/v1'),
  requestKey: z.string().regex(/^[a-f0-9]{64}$/),
  documentContent: z.string().min(1).max(50_000_000),
  documentType: z.enum(['lab', 'laboratory', 'radiology', 'wearable', 'other']),
  mimeType: z.string().min(1).max(200),
}).strict();

const outputSchema = z.object({
  status: z.literal('success'),
  documentCategory: z.string().min(1).max(100),
  observations: z.array(z.object({
    literalMarker: z.string().min(1).max(500),
    numericValue: z.number().finite().optional(),
  }).passthrough()).max(10_000),
}).passthrough();

export type HealthOcrHandlerResult =
  | { ok: true; output: z.infer<typeof outputSchema> }
  | { ok: false; code: 'HEALTH_OCR_REQUEST_REJECTED' | 'HEALTH_OCR_OUTPUT_REJECTED' | 'HEALTH_OCR_TEMPORARY_FAILURE' };

export function createHealthOcrHandler(dependencies: {
  execute: (input: z.infer<typeof inputSchema>) => Promise<unknown>;
  logger?: { info(message: string): void; warn(message: string): void };
}) {
  const logger = dependencies.logger ?? { info: () => undefined, warn: () => undefined };
  return async (input: unknown): Promise<HealthOcrHandlerResult> => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      logger.warn('health_ocr_request_rejected');
      return { ok: false, code: 'HEALTH_OCR_REQUEST_REJECTED' };
    }
    try {
      const output = outputSchema.safeParse(await dependencies.execute(parsed.data));
      if (!output.success) {
        logger.warn('health_ocr_output_rejected');
        return { ok: false, code: 'HEALTH_OCR_OUTPUT_REJECTED' };
      }
      logger.info('health_ocr_completed');
      return { ok: true, output: output.data };
    } catch {
      logger.warn('health_ocr_temporary_failure');
      return { ok: false, code: 'HEALTH_OCR_TEMPORARY_FAILURE' };
    }
  };
}
