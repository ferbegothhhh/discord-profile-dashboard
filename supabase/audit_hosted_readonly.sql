BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

WITH targets AS (
  SELECT c.oid, n.nspname, c.relname, c.relowner, c.relrowsecurity,
    c.relforcerowsecurity, c.relacl, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND (
    (n.nspname = 'public' AND c.relname LIKE 'profile\_%' ESCAPE '\')
    OR (n.nspname = 'storage' AND c.relname IN ('objects', 'buckets')))
), audit_roles AS (
  SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolbypassrls
  FROM pg_roles
  WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
    OR oid IN (SELECT relowner FROM targets)
), routines AS (
  SELECT p.*, n.nspname, l.lanname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
), policies AS (
  SELECT p.*, t.nspname, t.relname,
    pg_get_expr(p.polqual, p.polrelid) AS using_expression,
    pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  FROM pg_policy p JOIN targets t ON t.oid = p.polrelid
)
SELECT jsonb_build_object(
  'session', jsonb_build_object('read_only', current_setting('transaction_read_only'), 'database_role', current_user),
  'roles', (SELECT jsonb_agg(to_jsonb(r)) FROM audit_roles r),
  'role_memberships', (SELECT jsonb_agg(jsonb_build_object('role', parent.rolname, 'member', member.rolname,
      'admin_option', m.admin_option, 'inherit_option', m.inherit_option, 'set_option', m.set_option))
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE m.member IN (SELECT oid FROM audit_roles) OR m.roleid IN (SELECT oid FROM audit_roles)),
  'tables', (SELECT jsonb_agg(jsonb_build_object('schema', t.nspname, 'table', t.relname,
    'kind', t.relkind, 'owner', pg_get_userbyid(t.relowner), 'rls', t.relrowsecurity,
    'force_rls', t.relforcerowsecurity,
    'acl', (SELECT jsonb_agg(jsonb_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)) FROM aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a))) FROM targets t),
  'column_acls', (SELECT jsonb_agg(jsonb_build_object('schema', t.nspname, 'table', t.relname, 'column', a.attname,
    'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
    'privilege', x.privilege_type, 'grantable', x.is_grantable))
    FROM targets t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) x),
  'effective_table_privileges', (SELECT jsonb_agg(jsonb_build_object('schema', t.nspname, 'table', t.relname, 'role', r.rolname,
    'schema_usage', has_schema_privilege(r.oid, t.nspname, 'USAGE'),
    'select', has_table_privilege(r.oid, t.oid, 'SELECT'), 'insert', has_table_privilege(r.oid, t.oid, 'INSERT'),
    'update', has_table_privilege(r.oid, t.oid, 'UPDATE'), 'delete', has_table_privilege(r.oid, t.oid, 'DELETE'),
    'truncate', has_table_privilege(r.oid, t.oid, 'TRUNCATE'), 'references', has_table_privilege(r.oid, t.oid, 'REFERENCES'),
    'trigger', has_table_privilege(r.oid, t.oid, 'TRIGGER'),
    'maintain', has_table_privilege(r.oid, t.oid, 'MAINTAIN')))
    FROM targets t CROSS JOIN audit_roles r),
  'effective_column_privileges', (SELECT jsonb_agg(jsonb_build_object('schema', t.nspname, 'table', t.relname,
    'column', a.attname, 'role', r.rolname, 'select', has_column_privilege(r.oid, t.oid, a.attnum, 'SELECT'),
    'insert', has_column_privilege(r.oid, t.oid, a.attnum, 'INSERT'),
    'update', has_column_privilege(r.oid, t.oid, a.attnum, 'UPDATE'),
    'references', has_column_privilege(r.oid, t.oid, a.attnum, 'REFERENCES')))
    FROM targets t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN audit_roles r),
  'functions', (SELECT jsonb_agg(jsonb_build_object('schema', p.nspname, 'name', p.proname,
    'argument_types', oidvectortypes(p.proargtypes), 'return_type', pg_get_function_result(p.oid),
    'prokind', p.prokind, 'owner', pg_get_userbyid(p.proowner),
    'event_triggers', (SELECT jsonb_agg(jsonb_build_object('name', e.evtname,
      'event', e.evtevent, 'enabled', e.evtenabled, 'tags', e.evttags))
      FROM pg_event_trigger e WHERE e.evtfoid = p.oid),
    'definition_hash', CASE WHEN p.prokind IN ('f', 'p') THEN md5(pg_get_functiondef(p.oid)) END,
    'language', p.lanname, 'security_definer', p.prosecdef, 'volatility', p.provolatile,
    'search_path_settings', (SELECT jsonb_agg(v) FROM unnest(p.proconfig) v WHERE v LIKE 'search_path=%'),
    'body_hash', md5(p.prosrc),
    'acl', (SELECT jsonb_agg(jsonb_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'privilege', x.privilege_type, 'grantable', x.is_grantable)) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x),
    'effective_execute', (SELECT jsonb_agg(jsonb_build_object('role', r.rolname, 'execute', has_function_privilege(r.oid, p.oid, 'EXECUTE'))) FROM audit_roles r)))
    FROM routines p),
  'policies', (SELECT jsonb_agg(jsonb_build_object('schema', p.nspname, 'table', p.relname, 'name', p.polname,
    'permissive', p.polpermissive, 'command', p.polcmd,
    'roles', (SELECT jsonb_agg(CASE WHEN v = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(v) END) FROM unnest(p.polroles) v),
    'using_hash', md5(p.using_expression), 'check_hash', md5(p.check_expression),
    'using_literals_redacted', regexp_replace(p.using_expression, '''([^'']|'''')*''', '''[redacted]''', 'g'),
    'check_literals_redacted', regexp_replace(p.check_expression, '''([^'']|'''')*''', '''[redacted]''', 'g'),
    'using_mentions_target_bucket', position('profile-backgrounds' IN p.using_expression) > 0,
    'check_mentions_target_bucket', position('profile-backgrounds' IN p.check_expression) > 0)) FROM policies p),
  'default_privileges', (SELECT jsonb_agg(jsonb_build_object('owner', pg_get_userbyid(d.defaclrole),
    'schema', n.nspname, 'object_type', d.defaclobjtype,
    'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
    'privilege', x.privilege_type, 'grantable', x.is_grantable))
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE n.nspname IN ('public', 'storage') OR d.defaclnamespace = 0),
  'bucket', (SELECT jsonb_build_object('id', b.id, 'public', b.public,
    'file_size_limit', b.file_size_limit, 'allowed_mime_types', b.allowed_mime_types)
    FROM storage.buckets b WHERE b.id = 'profile-backgrounds')
) AS audit_metadata;

ROLLBACK;
