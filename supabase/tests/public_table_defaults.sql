BEGIN;

CREATE TABLE public.profile_default_acl_probe (id INTEGER);

DO $$
DECLARE
  client_role TEXT;
  privilege_name TEXT;
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.profile_default_acl_probe'::regclass)
    <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'Run disposable tests as postgres';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.profile_default_acl_probe'::regclass
      AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
  ) THEN
    RAISE EXCEPTION 'Unexpected client or PUBLIC default table ACL';
  END IF;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(client_role, 'public.profile_default_acl_probe', privilege_name) THEN
        RAISE EXCEPTION 'Unexpected effective privilege % for %', privilege_name, client_role;
      END IF;
      IF NOT has_table_privilege('postgres', 'public.profile_default_acl_probe', privilege_name) THEN
        RAISE EXCEPTION 'Owner privilege removed: %', privilege_name;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

ROLLBACK;
