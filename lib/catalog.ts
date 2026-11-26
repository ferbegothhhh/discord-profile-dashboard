export type Background = {
  id: string;
  name: string;
  color?: string;
  image?: string;
  category: "Katalog" | "Netral" | "Ungu";
};

export const backgrounds: readonly Background[] = [
  { id: "catalog-background-1", name: "Background 1", image: "/background1.jpeg", category: "Katalog" },
  { id: "catalog-background-2", name: "Background 2", image: "/background2.jpeg", category: "Katalog" },
];

const legacyBackgrounds: readonly Background[] = [
  { id: "sample-carbon", name: "Karbon (lama)", color: "#202024", category: "Netral" },
  { id: "sample-graphite", name: "Grafit (lama)", color: "#343438", category: "Netral" },
  { id: "sample-plum", name: "Plum (lama)", color: "#352442", category: "Ungu" },
  { id: "sample-violet", name: "Violet (lama)", color: "#493260", category: "Ungu" },
];

export const defaultBackgroundId = "catalog-background-1";
export const draftStorageKey = "profile-dashboard:draft:v1";

export const catalogMedia: Readonly<Record<string, { mime: "image/jpeg"; width: number; height: number }>> = Object.freeze({
  "catalog-background-1": Object.freeze({ mime: "image/jpeg", width: 735, height: 415 }),
  "catalog-background-2": Object.freeze({ mime: "image/jpeg", width: 736, height: 414 }),
});

export function findBackground(id: unknown): Background | undefined {
  return [...backgrounds, ...legacyBackgrounds].find((background) => background.id === id);
}

export function filterBackgrounds(items: readonly Background[], query: string, category: string) {
  const normalized = query.trim().toLocaleLowerCase("id-ID");
  return items.filter((item) =>
    (category === "Semua" || item.category === category) &&
    item.name.toLocaleLowerCase("id-ID").includes(normalized),
  );
}

export function parseDraft(raw: string | null): string | null {
  if (raw === null || raw.length > 512) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("version" in value) || !("backgroundId" in value)) return null;
    return value.version === 1 && backgrounds.some((item) => item.id === value.backgroundId) ? value.backgroundId as string : null;
  } catch {
    return null;
  }
}

export function serializeDraft(id: string): string {
  if (!backgrounds.some((item) => item.id === id)) throw new Error("Background tidak dikenal");
  return JSON.stringify({ version: 1, backgroundId: id });
}

export function isCatalog(value: unknown): value is { backgrounds: Background[] } {
  if (typeof value !== "object" || value === null || !("backgrounds" in value) || !Array.isArray(value.backgrounds)) return false;
  const ids = new Set<string>();
  return value.backgrounds.every((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("name" in item) || !("category" in item)) return false;
    const known = findBackground(item.id);
    if (!known || !backgrounds.some((background) => background.id === known.id) || ids.has(known.id)) return false;
    ids.add(known.id);
    return Object.keys(item).sort().join(",") === "category,id,image,name" && item.name === known.name && "image" in item && item.image === known.image && item.category === known.category;
  });
}
