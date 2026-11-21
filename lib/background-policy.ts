export const CUSTOM_SLOT_LEVELS = [20, 45, 65] as const;
export type CustomSlot = 1 | 2 | 3;
export type LevelSnapshot = { userId: string; guildId: string; level: number };

export function customSlotCount(level: unknown): number {
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level < 0) return 0;
  return CUSTOM_SLOT_LEVELS.filter((threshold) => level >= threshold).length;
}

export function isCustomSlot(value: unknown): value is CustomSlot {
  return value === 1 || value === 2 || value === 3;
}

export function canUseCustomSlot(snapshot: LevelSnapshot | null, userId: string, guildId: string, slot: unknown): boolean {
  if (!snapshot || !isCustomSlot(slot) || !/^[1-9]\d{16,19}$/.test(userId) || !/^[1-9]\d{16,19}$/.test(guildId)) return false;
  return snapshot.userId === userId && snapshot.guildId === guildId && slot <= customSlotCount(snapshot.level);
}

export function customSlots(snapshot: LevelSnapshot | null, userId: string, guildId: string) {
  return CUSTOM_SLOT_LEVELS.map((requiredLevel, index) => ({
    slot: (index + 1) as CustomSlot,
    requiredLevel,
    unlocked: canUseCustomSlot(snapshot, userId, guildId, index + 1),
  }));
}
