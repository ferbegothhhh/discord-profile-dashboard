BEGIN;

CREATE ROLE profile_dashboard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT profile_dashboard TO authenticator;
GRANT USAGE ON SCHEMA public TO profile_dashboard;

GRANT SELECT (id, name, asset_key, color, kind, visibility, owner_user_id, owner_guild_id, slot_number, revision, status, is_active, mime, width, height, byte_size, object_key)
  ON public.profile_backgrounds TO profile_dashboard;
GRANT SELECT (user_id, guild_id, background_id, updated_at),
  INSERT (user_id, guild_id, background_id, updated_at),
  UPDATE (user_id, guild_id, background_id, updated_at), DELETE
  ON public.profile_preferences TO profile_dashboard;

CREATE POLICY profile_dashboard_background_read ON public.profile_backgrounds
  FOR SELECT TO profile_dashboard USING (true);
CREATE POLICY profile_dashboard_preference_select ON public.profile_preferences
  FOR SELECT TO profile_dashboard USING (true);
CREATE POLICY profile_dashboard_preference_insert ON public.profile_preferences
  FOR INSERT TO profile_dashboard WITH CHECK (true);
CREATE POLICY profile_dashboard_preference_update ON public.profile_preferences
  FOR UPDATE TO profile_dashboard USING (true) WITH CHECK (true);
CREATE POLICY profile_dashboard_preference_delete ON public.profile_preferences
  FOR DELETE TO profile_dashboard USING (true);

GRANT EXECUTE ON FUNCTION public.reserve_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER),
  public.finalize_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER,TEXT,INTEGER,INTEGER,BIGINT,INTEGER),
  public.abort_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER),
  public.delete_profile_background_slot(TEXT,TEXT,INTEGER),
  public.reclaim_profile_backgrounds(INTEGER),
  public.claim_profile_background_cleanup(INTEGER),
  public.check_profile_background_cleanup(TEXT,UUID),
  public.ack_profile_background_cleanup(TEXT,UUID),
  public.fail_profile_background_cleanup(TEXT,UUID,TEXT),
  public.disable_guild_background(TEXT,TEXT,TEXT)
  TO profile_dashboard;

DO $$
DECLARE
  unsafe_functions TEXT;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO unsafe_functions
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
      AND EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      );
  IF unsafe_functions IS NOT NULL THEN
    RAISE EXCEPTION 'Restricted role would inherit PUBLIC EXECUTE on public-schema functions: %. Review each function, including extension-owned functions, and explicitly revoke unsafe grants before retrying.', unsafe_functions;
  END IF;
  RAISE NOTICE 'profile_dashboard inherits residual PUBLIC privileges, including extension-owned functions. Audit extension functions and PUBLIC schema/table privileges before enabling restricted mode.';
END;
$$;

COMMIT;
