import {generatePreferredResponse} from '../agent/capabilities/chatgpt-plan/preferred-generation.ts';

export interface AiCompletionParams {
  systemPrompt: string;
  userPrompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  temperature?: number;
  geminiModel?: string;
  provider?: 'gemini' | 'openai';
  signal?: AbortSignal;
  jsonSchema?: {name:string;schema:Record<string,unknown>};
}

export interface AiCompletionResult {
  parsed: any;
  provider: 'gemini' | 'openai';
  billingSource?: 'chatgpt-plan' | 'api-key';
  model?: string;
  reasoningEffort?: string;
}

/**
 * HARBOR_AI_PRIMARY=chatgpt: ChatGPT plan first, then API-key backup with the same model/effort.
 * Without this opt-in, retain the legacy Gemini/OpenAI selection below.
 * 1. Si GEMINI_API_KEY está configurada, intenta primero con Gemini API (gemini-2.0-flash / gemini-1.5-flash / gemini-3.1-flash-lite).
 * 2. Si falla o no está configurada, utiliza OPENAI_API_KEY (gpt-4o-mini).
 * 3. Soporta multimodalidad directa (imágenes en Base64 sin necesidad de workers locales ni Tesseract).
 * Si se indica provider, usa solo ese proveedor.
 */
export async function generateAiJsonResponse(
  params: AiCompletionParams
): Promise<AiCompletionResult | null> {
  if(process.env.HARBOR_AI_PRIMARY==='chatgpt') {
    try {
      const result=await generatePreferredResponse({prompt:params.userPrompt,instructions:params.systemPrompt,
        imageBase64:params.imageBase64,imageMimeType:params.imageMimeType,json:true,jsonSchema:params.jsonSchema,signal:params.signal});
      return {...result,parsed:result.parsed};
    } catch(error) {
      params.signal?.throwIfAborted();
      return null;
    }
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const temp = params.temperature ?? 0.2;

  // 1. INTENTAR CON GEMINI API SI GEMINI_API_KEY ESTÁ DISPONIBLE
  if (params.provider !== 'openai' && geminiKey && geminiKey.trim().length > 10) {
    const configuredModel = process.env.GEMINI_MODEL?.trim();
    const candidateModels = Array.from(new Set([
      params.geminiModel?.trim(),
      configuredModel,
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
    ].filter((m): m is string => Boolean(m))));

    for (const modelName of candidateModels) {
      let retriesLeft = 2;
      let backoffDelay = 1000;

      while (retriesLeft >= 0) {
        try {
          console.log(`[harbor-agent] 🤖 Conectando con Gemini API (${modelName}, temp: ${temp}, multimodal: ${Boolean(params.imageBase64)})...`);

          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey.trim()}`;

          const userParts: any[] = [];
          if (params.imageBase64) {
            const cleanBase64 = params.imageBase64.includes('base64,')
              ? params.imageBase64.split('base64,')[1]
              : params.imageBase64;
            userParts.push({
              inlineData: {
                mimeType: params.imageMimeType || 'image/jpeg',
                data: cleanBase64,
              },
            });
          }
          userParts.push({ text: params.userPrompt });

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Connection': 'keep-alive',
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: params.systemPrompt }],
              },
              contents: [
                {
                  role: 'user',
                  parts: userParts,
                },
              ],
              generationConfig: {
                temperature: temp,
                responseMimeType: 'application/json',
              },
            }),
            signal: params.signal,
          });

          if (res.ok) {
            const geminiJson = await res.json();
            const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              const parsed = JSON.parse(text);
              console.log(`[harbor-agent] ✅ RESPUESTA OBTENIDA CON ÉXITO DESDE GEMINI API (${modelName}).`);
              return { parsed, provider: 'gemini' };
            }
          } else {
            const errText = await res.text();
            console.warn(`[harbor-agent] ⚠️ Error HTTP de Gemini API con modelo ${modelName} (status ${res.status}): ${errText}`);
            if (res.status === 404) {
              console.log(`[harbor-agent] 🔄 Modelo ${modelName} no encontrado, probando siguiente modelo...`);
              break;
            }
            if ((res.status === 429 || res.status >= 500) && retriesLeft > 0) {
              retriesLeft--;
              await new Promise((r) => setTimeout(r, backoffDelay));
              backoffDelay *= 2;
              continue;
            }
            break;
          }
        } catch (geminiErr: any) {
          if (params.signal?.aborted) throw geminiErr;
          console.warn(`[harbor-agent] ⚠️ Excepción de conexión con Gemini (${modelName}):`, geminiErr?.message || geminiErr);
          if (retriesLeft > 0) {
            retriesLeft--;
            await new Promise((r) => setTimeout(r, backoffDelay));
            backoffDelay *= 2;
            continue;
          }
          break;
        }
      }
    }
  }

  // 2. FALLBACK A OPENAI API SI OPENAI_API_KEY ESTÁ DISPONIBLE
  if (params.provider !== 'gemini' && openaiKey && openaiKey.trim().length > 10) {
    try {
      const modelName = process.env.AI_MODEL || 'gpt-4o-mini';
      console.log(`[harbor-agent] 🤖 Conectando con OpenAI API (${modelName}, temp: ${temp}, multimodal: ${Boolean(params.imageBase64)})...`);

      let userContent: any = params.userPrompt;
      if (params.imageBase64) {
        const fullDataUrl = params.imageBase64.startsWith('data:')
          ? params.imageBase64
          : `data:${params.imageMimeType || 'image/jpeg'};base64,${params.imageBase64}`;
        userContent = [
          {
            type: 'image_url',
            image_url: { url: fullDataUrl },
          },
          { type: 'text', text: params.userPrompt },
        ];
      }

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey.trim()}`,
        },
        body: JSON.stringify({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: temp,
        }),
        signal: params.signal,
      });

      if (res.ok) {
        const aiJson = await res.json();
        const content = aiJson.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          console.log(`[harbor-agent] ✅ RESPUESTA OBTENIDA CON ÉXITO DESDE OPENAI API (${modelName}).`);
          return { parsed, provider: 'openai' };
        }
      } else {
        const errResText = await res.text();
        console.warn(`[harbor-agent] ⚠️ Error HTTP de OpenAI API (status ${res.status}): ${errResText}`);
      }
    } catch (openaiErr: any) {
      if (params.signal?.aborted) throw openaiErr;
      console.warn('[harbor-agent] ⚠️ Excepción al conectar con OpenAI API:', openaiErr?.message || openaiErr);
    }
  }

  console.warn(`[harbor-agent] ⚠️ Sin respuesta de IA (${params.provider ?? 'Gemini / OpenAI'}).`);
  return null;
}
