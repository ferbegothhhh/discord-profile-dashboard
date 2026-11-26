BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.profile_backgrounds
  DROP CONSTRAINT profile_backgrounds_kind_check,
  DROP CONSTRAINT profile_backgrounds_shape_check,
  ADD CONSTRAINT profile_backgrounds_kind_check CHECK (kind IN ('solid', 'image', 'catalog-image')),
  ADD CONSTRAINT profile_backgrounds_shape_check CHECK (
    (kind = 'solid' AND visibility = 'catalog' AND status = 'ready'
      AND asset_key IS NOT NULL AND object_key IS NULL AND mime IS NULL
      AND width IS NULL AND height IS NULL AND byte_size IS NULL)
    OR (kind = 'image' AND asset_key IS NULL AND color IS NULL
      AND object_key IS NOT NULL
      AND object_key ~ '^profile-images/[a-f0-9]{32}\.(png|jpg|webp)$'
      AND (mime IS NULL OR mime IN ('image/png', 'image/jpeg', 'image/webp'))
      AND (width IS NULL OR width > 0)
      AND (height IS NULL OR height > 0)
      AND (byte_size IS NULL OR byte_size > 0)
      AND (status <> 'ready' OR (mime IS NOT NULL AND width IS NOT NULL
        AND height IS NOT NULL AND byte_size IS NOT NULL)))
    OR (kind = 'catalog-image' AND visibility = 'catalog' AND status = 'ready'
      AND asset_key IS NOT NULL AND asset_key = id AND color IS NULL AND object_key IS NULL
      AND mime IS NOT NULL AND mime = 'image/jpeg' AND width IS NOT NULL AND height IS NOT NULL
      AND byte_size IS NULL
      AND ((id = 'catalog-background-1' AND width = 735 AND height = 415)
        OR (id = 'catalog-background-2' AND width = 736 AND height = 414)))
  );

INSERT INTO public.profile_backgrounds (id, name, asset_key, color, category, kind, mime, width, height)
VALUES
  ('catalog-background-1', 'Background 1', 'catalog-background-1', NULL, 'Katalog', 'catalog-image', 'image/jpeg', 735, 415),
  ('catalog-background-2', 'Background 2', 'catalog-background-2', NULL, 'Katalog', 'catalog-image', 'image/jpeg', 736, 414);

CREATE OR REPLACE FUNCTION public.validate_profile_background() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.background_id IS NOT NULL THEN
    PERFORM 1 FROM public.profile_backgrounds
    WHERE id = NEW.background_id AND is_active IS TRUE AND status = 'ready'
      AND ((kind = 'solid' AND visibility = 'catalog' AND asset_key = id
        AND ((id = 'sample-carbon' AND color = '#202024')
          OR (id = 'sample-graphite' AND color = '#343438')
          OR (id = 'sample-plum' AND color = '#352442')
          OR (id = 'sample-violet' AND color = '#493260')))
        OR (kind = 'catalog-image' AND visibility = 'catalog')
        OR (kind = 'image' AND (visibility = 'catalog'
          OR (visibility = 'private' AND owner_user_id = NEW.user_id
            AND owner_guild_id = NEW.guild_id))))
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Background unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_profile_background() FROM PUBLIC, anon, authenticated;

COMMIT;
