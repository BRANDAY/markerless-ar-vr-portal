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
