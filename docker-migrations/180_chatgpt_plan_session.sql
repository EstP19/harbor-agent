BEGIN;
SET LOCAL ROLE harbor_db_owner;
SET LOCAL lock_timeout='10s';

CREATE TABLE agent_core.chatgpt_plan_session (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL DEFAULT '' CHECK (octet_length(state)<=65536)
);
INSERT INTO agent_core.chatgpt_plan_session DEFAULT VALUES;
ALTER TABLE agent_core.chatgpt_plan_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_core.chatgpt_plan_session FROM PUBLIC,health_api,readonly_auditor,agent_api;
GRANT SELECT,UPDATE ON agent_core.chatgpt_plan_session TO agent_api;
CREATE POLICY chatgpt_plan_runtime ON agent_core.chatgpt_plan_session TO agent_api USING (singleton) WITH CHECK (singleton);

COMMIT;
