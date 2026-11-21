export type Background = {
  id: string;
  name: string;
  color: string;
  category: "Netral" | "Ungu";
};

export const backgrounds: readonly Background[] = [
  { id: "sample-carbon", name: "Karbon", color: "#202024", category: "Netral" },
  { id: "sample-graphite", name: "Grafit", color: "#343438", category: "Netral" },
  { id: "sample-plum", name: "Plum", color: "#352442", category: "Ungu" },
  { id: "sample-violet", name: "Violet", color: "#493260", category: "Ungu" },
];

export const defaultBackgroundId = "sample-carbon";
export const draftStorageKey = "profile-dashboard:draft:v1";

export function findBackground(id: unknown): Background | undefined {
  return backgrounds.find((background) => background.id === id);
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
    return value.version === 1 ? findBackground(value.backgroundId)?.id ?? null : null;
  } catch {
    return null;
  }
}

export function serializeDraft(id: string): string {
  if (!findBackground(id)) throw new Error("Background tidak dikenal");
  return JSON.stringify({ version: 1, backgroundId: id });
}

export function isCatalog(value: unknown): value is { backgrounds: Background[] } {
  if (typeof value !== "object" || value === null || !("backgrounds" in value) || !Array.isArray(value.backgrounds)) return false;
  const ids = new Set<string>();
  return value.backgrounds.every((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("name" in item) || !("color" in item) || !("category" in item)) return false;
    const known = findBackground(item.id);
    if (!known || ids.has(known.id)) return false;
    ids.add(known.id);
    return item.name === known.name && item.color === known.color && item.category === known.category;
  });
}
