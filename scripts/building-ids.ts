/** Building row names (PascalCase in the game data) → device ids used in data/devices.json */

export function pascalToKebab(str: string): string {
  return str
    .replace(/_/g, '-')  // Replace underscores with hyphens first
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '')
    .replace(/--+/g, '-');  // Replace multiple hyphens with single hyphen
}

// Special building ID mappings (remote ID → local ID)
export const BUILDING_ID_OVERRIDES: Record<string, string> = {
  'auto-nursery': 'nursery',
  'portal-alch-guild': 'purchasing-portal',
  'portal-bank': 'bank-portal',
  'portal-wholesaling': 'dispatch-portal',
};

export function buildingIdFor(rowName: string): string {
  const id = pascalToKebab(rowName);
  return BUILDING_ID_OVERRIDES[id] || id;
}
