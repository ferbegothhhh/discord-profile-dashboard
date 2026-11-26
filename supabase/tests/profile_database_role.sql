BEGIN;

DO $$
DECLARE
  function_name TEXT;
  table_name TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'profile_dashboard'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Restricted role attributes are unsafe';
  END IF;
  IF NOT pg_has_role('authenticator', 'profile_dashboard', 'MEMBER') THEN
    RAISE EXCEPTION 'Authenticator cannot select restricted role';
  END IF;
  IF has_table_privilege('profile_dashboard', 'public.profile_backgrounds', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT has_column_privilege('profile_dashboard', 'public.profile_backgrounds', 'object_key', 'SELECT')
    OR has_any_column_privilege('profile_dashboard', 'public.profile_backgrounds', 'INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Background privileges exceed scoped column reads';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['profile_background_cleanup', 'profile_background_object_keys', 'profile_background_moderation'] LOOP
    IF has_table_privilege('profile_dashboard', 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('profile_dashboard', 'public.' || table_name, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Restricted role has direct internal table access: %', table_name;
    END IF;
  END LOOP;
  IF has_table_privilege('profile_dashboard', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_any_column_privilege('profile_dashboard', 'storage.objects', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'Restricted role must not access storage';
  END IF;
  FOREACH function_name IN ARRAY ARRAY[
    'reserve_profile_background(text,text,integer,text,text,integer)',
    'finalize_profile_background(text,text,integer,text,text,integer,text,integer,integer,bigint,integer)',
    'abort_profile_background(text,text,integer,text,text,integer)',
    'delete_profile_background_slot(text,text,integer)',
    'reclaim_profile_backgrounds(integer)', 'claim_profile_background_cleanup(integer)',
    'check_profile_background_cleanup(text,uuid)', 'ack_profile_background_cleanup(text,uuid)',
    'fail_profile_background_cleanup(text,uuid,text)', 'disable_guild_background(text,text,text)'
  ] LOOP
    IF NOT has_function_privilege('profile_dashboard', 'public.' || function_name, 'EXECUTE') THEN
      RAISE EXCEPTION 'Missing restricted RPC: %', function_name;
    END IF;
  END LOOP;
END;
$$;

SET LOCAL ROLE profile_dashboard;
SELECT id, name, asset_key, color FROM public.profile_backgrounds LIMIT 1;
SELECT user_id, guild_id, background_id, updated_at FROM public.profile_preferences LIMIT 1;
INSERT INTO public.profile_preferences (user_id, guild_id, background_id, updated_at)
  VALUES ('988888888888888881', '988888888888888882', 'sample-carbon', now());
UPDATE public.profile_preferences SET background_id = 'sample-graphite'
  WHERE user_id = '988888888888888881' AND guild_id = '988888888888888882';
DELETE FROM public.profile_preferences
  WHERE user_id = '988888888888888881' AND guild_id = '988888888888888882';
RESET ROLE;

ROLLBACK;
