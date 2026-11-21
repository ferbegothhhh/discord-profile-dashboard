BEGIN;

CREATE TABLE public.profile_background_moderation (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id TEXT NOT NULL CHECK (actor_user_id ~ '^[1-9][0-9]{16,19}$'),
  guild_id TEXT NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{16,19}$'),
  background_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profile_background_moderation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_background_moderation FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.profile_background_moderation TO service_role;

CREATE FUNCTION public.disable_guild_background(p_actor_id TEXT, p_guild_id TEXT, p_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  target public.profile_backgrounds%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id !~ '^[1-9][0-9]{16,19}$'
    OR p_guild_id IS NULL OR p_guild_id !~ '^[1-9][0-9]{16,19}$'
    OR p_id IS NULL OR p_id !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid target' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO target FROM public.profile_backgrounds
    WHERE id = p_id AND owner_guild_id = p_guild_id AND kind = 'image'
      AND visibility = 'private' AND status = 'ready' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF target.is_active THEN
    UPDATE public.profile_backgrounds SET is_active = false WHERE id = target.id;
    UPDATE public.profile_preferences SET background_id = NULL WHERE background_id = target.id;
    INSERT INTO public.profile_background_moderation (actor_user_id, guild_id, background_id)
      VALUES (p_actor_id, p_guild_id, target.id);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.disable_guild_background(TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disable_guild_background(TEXT,TEXT,TEXT) TO service_role;
CREATE INDEX profile_backgrounds_guild_review ON public.profile_backgrounds (owner_guild_id, id)
  WHERE kind = 'image' AND visibility = 'private' AND status = 'ready';

COMMIT;
