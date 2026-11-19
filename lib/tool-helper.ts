import type { z, ZodTypeAny } from 'zod';

export interface ToolDefinition<TSchema extends ZodTypeAny = any, TResult = any> {
  description?: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export function defineTool<TSchema extends ZodTypeAny, TResult = any>(
  def: ToolDefinition<TSchema, TResult>
): ToolDefinition<TSchema, TResult> {
  return def;
}
