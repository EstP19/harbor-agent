---
name: rag-search
description: Consulta e indexa fragmentos de conocimiento general en el motor vectorial agent_vector usando pgvector.
---
# RAG Search (general_rag)

Esta habilidad permite realizar búsquedas semánticas sobre las fuentes autorizadas de la Knowledge Base pública de Harbor.

## Reglas Obligatorias:
1. Filtra las búsquedas por `data_class_code = 'general_kb'`.
2. Devuelve los fragmentos más relevantes junto con su código de fuente y revisión.
3. No expone datos ni expedientes personales de usuarios.
