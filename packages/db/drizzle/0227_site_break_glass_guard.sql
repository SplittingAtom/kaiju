-- KOBE-648 (v1.3 Semantic Memory SMA11c, SM28; amends D10): the rules of the Site-level break-glass
-- grant (0226) for one person's portable memories. Custom, so db:rebase keeps this SQL as written.
--
-- site_break_glass_grants follows break_glass_grants_guard() (0023, as renamed by 0091): every grant
-- starts as a pending request by an active site admin, stamped by the database with a 24-hour
-- request deadline; a second active site admin approves (a site whose only other active admin is
-- the subject, or that has no other, self-approves, flagged), which sets the window now() +
-- duration (<= 24 h); a pending request is denied by another admin or withdrawn (revoked) by any
-- admin; an approved grant is revoked by any admin; the sweep records expiry only once the window
-- or the deadline has passed. What was asked for never changes. Unlike the Workspace grant, the
-- subject is always named, so the subject can never request (CHECK), approve, deny or revoke a
-- grant about themselves, even when they are a site admin. The approval takes the site admin set
-- lock (break_glass_lock_admin_set) and share-locks the other admins' rows, as the Workspace
-- grant does. break_glass_grants_guard() itself is untouched. Everything is SECURITY INVOKER with
-- a pinned search_path.

CREATE FUNCTION "public"."site_break_glass_grants_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Every grant starts as a pending request; the database stamps its times.
    IF NEW.status <> 'pending' OR NEW.approver_id IS NOT NULL OR NEW.self_approved
       OR NEW.decided_at IS NOT NULL OR NEW.decided_by IS NOT NULL OR NEW.starts_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'break-glass grants start as pending requests' USING ERRCODE = '55000';
    END IF;
    IF NOT "public"."break_glass_is_site_admin"(NEW.admin_id) THEN
      RAISE EXCEPTION 'only a site admin can request break-glass' USING ERRCODE = '42501';
    END IF;
    NEW.requested_at := now();
    NEW.request_expires_at := now() + interval '24 hours';
    RETURN NEW;
  END IF;

  -- What was asked for never changes.
  IF (NEW.id, NEW.subject_user_id, NEW.admin_id, NEW.reason, NEW.legal_hold, NEW.duration_minutes,
      NEW.requested_at, NEW.request_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.subject_user_id, OLD.admin_id, OLD.reason, OLD.legal_hold, OLD.duration_minutes,
      OLD.requested_at, OLD.request_expires_at) THEN
    RAISE EXCEPTION 'a break-glass request cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.approver_id, NEW.self_approved, NEW.decided_at, NEW.decided_by, NEW.starts_at,
        NEW.expires_at, NEW.ended_at)
       IS DISTINCT FROM
       (OLD.approver_id, OLD.self_approved, OLD.decided_at, OLD.decided_by, OLD.starts_at,
        OLD.expires_at, OLD.ended_at) THEN
      RAISE EXCEPTION 'a break-glass decision cannot be changed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF now() >= OLD.request_expires_at THEN
      RAISE EXCEPTION 'the break-glass request lapsed' USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."break_glass_lock_admin_set"();
    IF NEW.approver_id IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.approver_id) THEN
      RAISE EXCEPTION 'only an active site admin can approve break-glass' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id = OLD.subject_user_id THEN
      RAISE EXCEPTION 'the subject of a break-glass request cannot approve it' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id = OLD.admin_id THEN
      -- D10: a second admin approves when an active one exists who is not the subject; only then
      -- may the requester approve alone, and the grant is flagged. The other admins' rows are
      -- share-locked (belt and braces with the admin-set lock).
      IF "public"."legal_hold_other_admin_exists"(OLD.admin_id, OLD.subject_user_id) THEN
        RAISE EXCEPTION 'a second site admin must approve this request' USING ERRCODE = '42501';
      END IF;
      NEW.self_approved := true;
    ELSE
      NEW.self_approved := false;
    END IF;
    NEW.decided_at := now();
    NEW.decided_by := NEW.approver_id;
    NEW.starts_at := now();
    NEW.expires_at := now() + make_interval(mins => OLD.duration_minutes);
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.self_approved <> OLD.self_approved
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'only an approval sets the approver and the window' USING ERRCODE = '55000';
  END IF;

  IF (OLD.status = 'pending' AND NEW.status IN ('denied', 'revoked'))
     OR (OLD.status = 'approved' AND NEW.status = 'revoked') THEN
    -- Denied by a site admin other than the requester; revoked (or withdrawn) by any site admin
    -- except the subject.
    IF NEW.decided_by IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.decided_by) THEN
      RAISE EXCEPTION 'only a site admin can deny or revoke break-glass' USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by = OLD.subject_user_id THEN
      RAISE EXCEPTION 'the subject of a break-glass request cannot decide it' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'denied' AND NEW.decided_by = OLD.admin_id THEN
      RAISE EXCEPTION 'withdraw your own request instead of denying it' USING ERRCODE = '42501';
    END IF;
    NEW.decided_at := now();
    NEW.ended_at := now();
    RETURN NEW;
  END IF;

  IF NEW.status = 'expired' AND (
       (OLD.status = 'pending' AND now() >= OLD.request_expires_at)
       OR (OLD.status = 'approved' AND now() >= OLD.expires_at)) THEN
    IF OLD.status = 'pending' THEN NEW.decided_at := now(); END IF;
    NEW.decided_by := OLD.decided_by;
    NEW.ended_at := COALESCE(OLD.expires_at, now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'break-glass grant cannot go from % to %', OLD.status, NEW.status
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "site_break_glass_grants_guard" BEFORE INSERT OR UPDATE ON "site_break_glass_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."site_break_glass_grants_guard"();
