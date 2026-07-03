import type { SpecialUse } from './mail';

/** IMAP SPECIAL-USE attributes (RFC 6154 + common \\Inbox) -> our SpecialUse. */
const ATTR_TO_SPECIAL_USE: Readonly<Record<string, SpecialUse>> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
};

/** Folder-name conventions (fallback when no attributes are advertised). */
const NAME_TO_SPECIAL_USE: ReadonlyArray<readonly [RegExp, SpecialUse]> = [
  [/^inbox$/i, 'inbox'],
  [/^sent(\s?items)?$/i, 'sent'],
  [/^drafts?$/i, 'drafts'],
  [/^(junk|spam|bulk\s?mail)$/i, 'junk'],
  [/^(trash|deleted\s?items|bin)$/i, 'trash'],
  [/^archive$/i, 'archive'],
];

/** Map advertised SPECIAL-USE attributes (e.g. "\\Sent") to our SpecialUse; 'normal' if none match. */
export function specialUseFromAttributes(attributes: Iterable<string>): SpecialUse {
  for (const a of attributes) {
    const su = ATTR_TO_SPECIAL_USE[a];
    if (su) return su;
  }
  return 'normal';
}

/** Map a folder name (last path segment) to a SpecialUse via common conventions; 'normal' if unknown. */
export function specialUseFromName(name: string): SpecialUse {
  const trimmed = name.trim();
  for (const [re, su] of NAME_TO_SPECIAL_USE) {
    if (re.test(trimmed)) return su;
  }
  return 'normal';
}

/** Prefer advertised attributes; fall back to the folder name. */
export function detectSpecialUse(name: string, attributes?: Iterable<string>): SpecialUse {
  if (attributes) {
    const byAttr = specialUseFromAttributes(attributes);
    if (byAttr !== 'normal') return byAttr;
  }
  return specialUseFromName(name);
}
