BEGIN;

CREATE TABLE IF NOT EXISTS public.profile_backgrounds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    asset_key TEXT NOT NULL,
    color TEXT DEFAULT '#202024',
    category TEXT DEFAULT 'Lainnya',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profile_preferences (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    background_id TEXT REFERENCES public.profile_backgrounds(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, guild_id)
);

ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#202024';
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Lainnya';
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE public.profile_backgrounds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.profile_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.profile_backgrounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read on backgrounds" ON public.profile_backgrounds;
REVOKE ALL ON public.profile_backgrounds, public.profile_preferences FROM PUBLIC, anon, authenticated;

INSERT INTO public.profile_backgrounds (id, name, asset_key, color, category) VALUES
('sample-carbon', 'Karbon', 'sample-carbon', '#202024', 'Netral'),
('sample-graphite', 'Grafit', 'sample-graphite', '#343438', 'Netral'),
('sample-plum', 'Plum', 'sample-plum', '#352442', 'Ungu'),
('sample-violet', 'Violet', 'sample-violet', '#493260', 'Ungu')
ON CONFLICT (id) DO NOTHING;

COMMIT;
