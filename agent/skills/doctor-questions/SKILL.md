---
name: doctor-questions
description: Genera 3 preguntas amigables y orientativas para que el paciente las realice a su médico sobre un tema de salud o marcador analítico.
---
# Doctor Questions (health_doctor_questions)

Esta habilidad recibe el tema general de salud o parámetro de la Knowledge Base y formula preguntas clave para la consulta médica.

## Reglas Obligatorias:
1. Genera exactamente 3 preguntas claras, concisas y orientativas.
2. Usa un tono empático y fácil de entender por cualquier paciente.
3. Configura `temperature = 0.2` para mantener respuestas deterministas y coherentes.
4. NO recibas ni asocies datos personales, historial clínico ni valores personales del paciente.
