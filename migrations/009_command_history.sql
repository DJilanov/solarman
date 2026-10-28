ALTER TABLE command_executions ADD COLUMN device text;
WITH evidence AS (
  SELECT tenant_id,execution_id,device FROM inverter_write_intents WHERE execution_id IS NOT NULL
  UNION ALL
  SELECT c.tenant_id,c.id,e->'report'->>'device'
  FROM command_executions c CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.detail->'events')='array' THEN c.detail->'events' ELSE '[]'::jsonb END
  ) e
  WHERE e->>'event'='device_verification' AND jsonb_typeof(e->'report'->'device')='string'
  AND e->'report'->>'device'<>''
), unambiguous AS (
  SELECT tenant_id,execution_id,min(device) AS device FROM evidence
  GROUP BY tenant_id,execution_id HAVING count(DISTINCT device)=1
)
UPDATE command_executions c SET device=w.device FROM unambiguous w
WHERE c.tenant_id=w.tenant_id AND c.id=w.execution_id;
CREATE INDEX inverter_write_intents_execution_time ON inverter_write_intents (tenant_id,execution_id,created_at,id);
CREATE INDEX inverter_write_intents_tenant_time ON inverter_write_intents (tenant_id,created_at,id);
