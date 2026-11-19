import assert from 'node:assert/strict';
import test from 'node:test';
import {chatGptGenerationSettings} from '../agent/capabilities/chatgpt-plan/generation-settings.ts';

test('ChatGPT generation defaults do not add overrides and reject invalid operator settings',()=>{
  assert.deepEqual(chatGptGenerationSettings({}),{});
  assert.deepEqual(chatGptGenerationSettings({HARBOR_CHATGPT_MODEL:' gpt-6-luna ',HARBOR_CHATGPT_REASONING_EFFORT:' high '}),
    {model:'gpt-6-luna',reasoningEffort:'high'});
  assert.throws(()=>chatGptGenerationSettings({HARBOR_CHATGPT_REASONING_EFFORT:'custom'}),/CHATGPT_CONFIG_INVALID/);
  assert.throws(()=>chatGptGenerationSettings({HARBOR_CHATGPT_MODEL:'model\ninvalid'}),/CHATGPT_CONFIG_INVALID/);
});
