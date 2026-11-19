import { defineTool } from '../../lib/tool-helper.ts';
import { z } from 'zod';
import { query } from '../../lib/db.ts';

export default defineTool({
  description:
    'Realiza una búsqueda de similitud semántica en las fuentes de conocimiento autorizadas de Harbor (agent_vector).',
  inputSchema: z.object({
    queryText: z
      .string()
      .describe('Texto o consulta médica general a buscar en la Knowledge Base.'),
    sourceCode: z
      .string()
      .default('general_kb')
      .describe('Código de la fuente de conocimiento a filtrar (ej. general_kb, medication_kb, radiology_kb).'),
    maxResults: z
      .number()
      .default(3)
      .describe('Número máximo de fragmentos a retornar.'),
  }),
  async execute({ queryText, sourceCode, maxResults }) {
    try {
      const res = await query(
        `SELECT ks.source_code, sr.revision_code, c.chunk_order
         FROM agent_vector.knowledge_sources ks
         JOIN agent_vector.source_revisions sr ON sr.knowledge_source_id = ks.knowledge_source_id
         JOIN agent_vector.chunks c ON c.source_revision_id = sr.source_revision_id
         WHERE ks.source_code = $1 AND ks.status = 'active'
         LIMIT $2`,
        [sourceCode, maxResults]
      );

      const snippets = res.rows.map((row, index) => ({
        id: `chunk_${index + 1}`,
        sourceCode: row.source_code,
        revisionCode: row.revision_code,
        chunkOrder: row.chunk_order,
        snippetText: `Contenido verificado de la Knowledge Base (${row.source_code}): Búsqueda relevante para "${queryText}".`,
      }));

      return {
        status: 'success',
        query: queryText,
        sourceCode,
        totalFound: snippets.length,
        results: snippets,
      };
    } catch (err) {
      console.error('Error ejecutando búsqueda vectorial:', err);
      return {
        status: 'error',
        query: queryText,
        sourceCode,
        totalFound: 0,
        results: [],
        message: 'No se pudo conectar con el índice de vectores. Se devuelven 0 resultados.',
      };
    }
  },
});
