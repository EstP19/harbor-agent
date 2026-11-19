import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { readDoctorQuestionsBody } from '../agent/capabilities/health-doctor-questions/route.ts';
import { readDetailedExplanationBody } from '../agent/capabilities/health-detailed-explanation/route.ts';

for (const read of [readDoctorQuestionsBody, readDetailedExplanationBody]) {
  test(`${read.name} accepts a Vercel parsed body without waiting for a consumed stream`, async () => {
    for (const body of [{ questions: ['¿Qué es glucosa?'] }, '{"questions":[]}', Buffer.from('{"questions":[]}')]) {
      const request = Object.assign(Readable.from([]), { body });
      const result = await read(request);
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(Array.isArray(JSON.parse(result.bodyText).questions));
    }
  });
  test(`${read.name} enforces byte limits on both parsed and streaming UTF-8 bodies`, async () => {
    for (const request of [Object.assign(Readable.from([]), { body: 'é'.repeat(5) }), Readable.from(['é'.repeat(5)])]) {
      const result = await read(request, 9);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.code, /PAYLOAD_TOO_LARGE/);
    }
    const invalid = Object.assign(Readable.from([]), { body: {} });
    Object.assign(invalid.body, { toJSON() { throw new Error('private'); } });
    const failed = await read(invalid);
    assert.equal(failed.ok, false);
    assert.doesNotMatch(JSON.stringify(failed), /private/);
  });
}
