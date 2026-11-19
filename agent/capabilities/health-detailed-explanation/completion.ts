interface CompletionLogger {
  warn(message: 'detailed explanation provider request failed' | 'detailed explanation provider response rejected'): void;
}

interface CompletionDependencies {
  apiKey: string | undefined;
  model: string;
  fetch: typeof globalThis.fetch;
  logger: CompletionLogger;
}

export function createDetailedExplanationCompletion(dependencies: CompletionDependencies) {
  return async (prompt: { systemPrompt: string; userPrompt: string }, signal?: AbortSignal): Promise<unknown> => {
    if (!dependencies.apiKey || dependencies.apiKey.trim().length === 0) {
      dependencies.logger.warn('detailed explanation provider request failed');
      throw new Error('completion unavailable');
    }
    let response: Response;
    try {
      response = await dependencies.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dependencies.apiKey.trim()}` },
        body: JSON.stringify({
          model: dependencies.model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: prompt.systemPrompt }, { role: 'user', content: prompt.userPrompt }],
          temperature: 0.2,
        }),
      });
    } catch {
      dependencies.logger.warn('detailed explanation provider request failed');
      throw new Error('completion unavailable');
    }
    if (!response.ok) {
      dependencies.logger.warn('detailed explanation provider request failed');
      throw new Error('completion unavailable');
    }
    try {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('missing completion');
      return JSON.parse(content);
    } catch {
      dependencies.logger.warn('detailed explanation provider response rejected');
      throw new Error('completion unavailable');
    }
  };
}
