---
name: vector-ingest
description: Fragmenta, genera hashes e ingesta documentos en agent_vector (PostgreSQL) para vectorización en el agente.
---
# Vector Ingest (general_vector_ingest)

Esta habilidad procesa documentos de la Knowledge Base o reglas clínicas para fragmentarlos e insertarlos en la base de datos de vectores.

## Reglas Obligatorias:
1. Divide el texto del documento en bloques lógicos o párrafos continuos (~350-400 caracteres).
2. Genera hashes SHA256 para verificar la integridad del contenido.
3. Inserta los registros en las tablas de PostgreSQL `agent_vector.knowledge_sources`, `agent_vector.source_revisions` y `agent_vector.chunks`.
4. Garantiza la trazabilidad en `agent_core.requests` y `agent_core.runs`.
