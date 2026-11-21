BEGIN;

CREATE TABLE public.profile_background_object_keys (
  object_key TEXT PRIMARY KEY CHECK (object_key ~ '^profile-images/[a-f0-9]{32}\.(png|jpg|webp)$')
);
ALTER TABLE public.profile_background_object_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_background_object_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (object_key), INSERT (object_key) ON public.profile_background_object_keys TO service_role;

INSERT INTO public.profile_background_object_keys (object_key)
SELECT object_key FROM public.profile_backgrounds WHERE object_key IS NOT NULL;

CREATE TABLE public.profile_background_cleanup (
  object_key TEXT PRIMARY KEY CHECK (object_key ~ '^profile-images/[a-f0-9]{32}\.png$'),
  reason TEXT NOT NULL CHECK (reason IN ('upload_aborted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profile_background_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_background_cleanup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_background_cleanup TO service_role;

CREATE FUNCTION public.reserve_profile_background(p_user_id TEXT, p_guild_id TEXT, p_slot INTEGER, p_id TEXT, p_object_key TEXT, p_revision INTEGER)
RETURNS TABLE(id TEXT, object_key TEXT, revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id !~ '^[1-9][0-9]{16,19}$'
    OR p_guild_id IS NULL OR p_guild_id !~ '^[1-9][0-9]{16,19}$'
    OR p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 3
    OR p_id IS NULL OR p_id !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p_object_key IS NULL OR p_object_key !~ '^profile-images/[a-f0-9]{32}\.png$'
    OR p_revision IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Invalid reservation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_background_cleanup c WHERE c.object_key = p_object_key) THEN
    RAISE EXCEPTION 'Object key already used' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.profile_background_object_keys (object_key) VALUES (p_object_key);
  INSERT INTO public.profile_backgrounds AS b
    (id, name, asset_key, color, category, is_active, kind, visibility, owner_user_id, owner_guild_id, slot_number, status, object_key, revision)
  VALUES (p_id, 'Background pribadi ' || p_slot, NULL, NULL, 'Pribadi', false, 'image', 'private', p_user_id, p_guild_id, p_slot, 'processing', p_object_key, 1);
  RETURN QUERY SELECT b.id, b.object_key, b.revision FROM public.profile_backgrounds b WHERE b.id = p_id;
END;
$$;

CREATE FUNCTION public.finalize_profile_background(p_user_id TEXT, p_guild_id TEXT, p_slot INTEGER, p_id TEXT, p_object_key TEXT, p_revision INTEGER, p_mime TEXT, p_width INTEGER, p_height INTEGER, p_byte_size BIGINT, p_level INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  background public.profile_backgrounds%ROWTYPE;
BEGIN
  SELECT * INTO background FROM public.profile_backgrounds b WHERE b.id = p_id FOR UPDATE;
  IF NOT FOUND OR background.owner_user_id IS DISTINCT FROM p_user_id
    OR background.owner_guild_id IS DISTINCT FROM p_guild_id OR background.slot_number IS DISTINCT FROM p_slot
    OR background.kind <> 'image' OR background.visibility <> 'private'
    OR background.status <> 'processing' OR background.is_active IS DISTINCT FROM false
    OR background.object_key IS DISTINCT FROM p_object_key OR background.revision IS DISTINCT FROM p_revision
    OR p_revision IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE = '23514';
  END IF;
  IF p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 3 OR p_level IS NULL
    OR p_level < (CASE p_slot WHEN 1 THEN 20 WHEN 2 THEN 45 WHEN 3 THEN 65 ELSE 2147483647 END)
    OR p_mime IS DISTINCT FROM 'image/png' OR p_width IS DISTINCT FROM 1000 OR p_height IS DISTINCT FROM 560
    OR p_object_key IS NULL OR p_object_key !~ '^profile-images/[a-f0-9]{32}\.png$'
    OR p_byte_size IS NULL OR p_byte_size < 1 OR p_byte_size > 2305536 THEN
    RAISE EXCEPTION 'Invalid upload metadata' USING ERRCODE = '23514';
  END IF;
  UPDATE public.profile_backgrounds b SET status = 'ready', is_active = true,
    mime = p_mime, width = p_width, height = p_height, byte_size = p_byte_size, revision = b.revision + 1
    WHERE b.id = p_id AND b.owner_user_id = p_user_id AND b.owner_guild_id = p_guild_id
      AND b.slot_number = p_slot AND b.status = 'processing' AND b.revision = p_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE FUNCTION public.abort_profile_background(p_user_id TEXT, p_guild_id TEXT, p_slot INTEGER, p_id TEXT, p_object_key TEXT, p_revision INTEGER)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  removed_key TEXT;
BEGIN
  DELETE FROM public.profile_backgrounds b WHERE b.id = p_id AND b.owner_user_id = p_user_id
    AND b.owner_guild_id = p_guild_id AND b.slot_number = p_slot AND b.kind = 'image'
    AND b.visibility = 'private' AND b.status = 'processing' AND b.is_active IS FALSE
    AND b.revision = p_revision AND b.object_key = p_object_key
  RETURNING b.object_key INTO removed_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE = '23514'; END IF;
  INSERT INTO public.profile_background_cleanup (object_key, reason) VALUES (removed_key, 'upload_aborted')
    ON CONFLICT (object_key) DO NOTHING;
  RETURN removed_key;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER,TEXT,INTEGER,INTEGER,BIGINT,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER,TEXT,INTEGER,INTEGER,BIGINT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_profile_background(TEXT,TEXT,INTEGER,TEXT,TEXT,INTEGER) TO service_role;

COMMIT;
