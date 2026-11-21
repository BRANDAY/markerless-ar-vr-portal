/**
 * Names of rooms. The server knows a room by an id ("room", "living_room"); the user sees
 * a name. Until the server keeps a label per room that every phone can read, the name is
 * made from the id. Pure.
 */

/** "living_room" -> "Living room". */
export function roomDisplayName(mapId: string): string {
  const words = mapId.replace(/[_-]+/g, ' ').trim();
  if (!words) {
    return mapId;
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A room name made safe as an id for the server: lower case letters, digits and
 * underscores, at most 40 characters. An empty result falls back to "room".
 */
export function roomIdFromName(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return id || 'room';
}

/**
 * The id for a NEW room with this name: the name made safe, with "_2", "_3"... appended
 * while a room with that id exists (a new scan must not replace another room).
 */
export function newRoomId(name: string, existingIds: readonly string[]): string {
  const base = roomIdFromName(name);
  if (!existingIds.includes(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 36)}_${n}`;
    if (!existingIds.includes(candidate)) {
      return candidate;
    }
  }
}

/**
 * The number for the default name of a new room ("Room {n}"): one more than the rooms
 * there are, raised until neither the name's id nor the name itself is taken.
 */
export function nextRoomNumber(existingIds: readonly string[], existingNames: readonly string[], nameOf: (n: number) => string): number {
  for (let n = existingIds.length + 1; ; n += 1) {
    const name = nameOf(n);
    if (!existingIds.includes(roomIdFromName(name)) && !existingNames.includes(name)) {
      return n;
    }
  }
}
