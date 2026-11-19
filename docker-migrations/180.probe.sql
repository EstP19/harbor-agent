WITH target AS (SELECT to_regclass('agent_core.chatgpt_plan_session') AS relation)
SELECT relation IS NOT NULL AS present,
 coalesce((SELECT relrowsecurity FROM pg_class WHERE oid=relation)
  AND has_table_privilege('agent_api',relation,'SELECT')
  AND has_table_privilege('agent_api',relation,'UPDATE')
  AND NOT has_table_privilege('agent_api',relation,'INSERT,DELETE,TRUNCATE')
  AND NOT has_table_privilege('health_api',relation,'SELECT,UPDATE')
  AND NOT has_table_privilege('readonly_auditor',relation,'SELECT,UPDATE')
  AND EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation AND polname='chatgpt_plan_runtime'),
 false) AS valid
FROM target;
