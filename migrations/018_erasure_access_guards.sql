CREATE FUNCTION reject_erased_authentication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_tenant uuid;
BEGIN
  SELECT tenant_id INTO target_tenant FROM users WHERE id=NEW.user_id FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM workspace_offboarding o WHERE o.tenant_id=target_tenant AND o.erasure_authorized_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Workspace erasure forbids authentication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_erasure_guard BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_erased_authentication();
CREATE TRIGGER recovery_erasure_guard BEFORE INSERT ON account_recovery_tokens FOR EACH ROW EXECUTE FUNCTION reject_erased_authentication();

CREATE FUNCTION reject_retired_provider_requests() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace_state text;
BEGIN
  SELECT lifecycle INTO workspace_state FROM tenants WHERE id=NEW.tenant_id FOR KEY SHARE;
  IF workspace_state='removed' OR (workspace_state='offboarding' AND NEW.purpose='routine')
    OR EXISTS(SELECT 1 FROM workspace_offboarding o WHERE o.tenant_id=NEW.tenant_id AND (o.erasure_started_at IS NOT NULL OR NEW.purpose='routine')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Workspace closure forbids routine provider access';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER api_requests_erasure_guard BEFORE INSERT ON api_requests FOR EACH ROW EXECUTE FUNCTION reject_retired_provider_requests();

CREATE FUNCTION preserve_workspace_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.lifecycle='removed' AND NEW.lifecycle<>'removed')
    OR (NEW.lifecycle NOT IN('offboarding','removed') AND EXISTS(SELECT 1 FROM workspace_offboarding WHERE tenant_id=NEW.id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Workspace closure cannot be reversed through availability';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_closure_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION preserve_workspace_closure();

CREATE FUNCTION preserve_closed_controller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.control_enabled OR NOT NEW.paused OR NEW.manual_topup)
    AND EXISTS(SELECT 1 FROM workspace_offboarding WHERE tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Workspace closure forbids automation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER controller_closure_guard BEFORE INSERT OR UPDATE ON controller_state FOR EACH ROW EXECUTE FUNCTION preserve_closed_controller();
