-- Restoring normal settings after a failed start is not a completed night trial.
UPDATE energy_plans p
SET state='failed',code='start-unconfirmed',updated_at=clock_timestamp()
WHERE p.state='completed'
  AND EXISTS (
    SELECT 1 FROM outage_preparations o
    WHERE o.tenant_id=p.tenant_id AND o.energy_plan_id=p.id
      AND o.purpose='night' AND o.state='restored'
      AND o.proof->'applyWritesVerified' IS DISTINCT FROM 'true'::jsonb
      AND EXISTS (
        SELECT 1 FROM command_executions c
        WHERE c.tenant_id=o.tenant_id AND c.action='outage_prepare'
          AND c.status IN('failed','interrupted')
          AND c.detail->'outage'->>'id'=o.id::text
      )
  );
