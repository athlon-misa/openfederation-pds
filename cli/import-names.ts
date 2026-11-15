/**
 * Names typed as plain text (#403).
 *
 * Mentions are rewritten from the platform's own markup (`<@id>`, `<@U123>`,
 * the rendered `@name`), but people also write each other's names plainly:
 * "thanks Alice", "ask bob_reads". When authors are pseudonymised those
 * names would still be published, so the importer also looks for the names
 * of the people in the export's own user list (display names, usernames, and
 * the first word of a display name) as whole words, ignoring case, and
 * replaces them with that person's label.
 *
 * To avoid rewriting ordinary words, a name is not looked for when it is
 * shorter than three characters, is only digits, or is in a small list of
 * common words that are also names ("Will", "May", "Rose", "Grace") or that
 * appear in labels ("member", "Discord"). A name two people share is
 * replaced by "someone", since either could be meant. The dry run lists
 * every replacement it would make, so the organiser can check.
 *
 * Heuristic: it cannot catch nicknames nobody set, misspellings, or a name
 * someone shares with a person outside the export.
 */

export const MIN_NAME_CHARS = 3;

/** Words never treated as a name, even when someone is called that. Lowercase. */
export const NAME_STOPLIST: ReadonlySet<string> = new Set([
  // Labels the importer writes, and words of the platforms.
  'discord', 'slack', 'member', 'members', 'someone', 'everyone', 'here', 'channel', 'general', 'random', 'thread',
  'admin', 'mod', 'moderator', 'bot', 'user', 'users', 'guest', 'team', 'staff', 'owner', 'test',
  // Common words.
  'the', 'and', 'all', 'any', 'you', 'one', 'two', 'new', 'now', 'see', 'who', 'how', 'why', 'can', 'not', 'yes',
  'our', 'out', 'day', 'way', 'man', 'boy', 'girl', 'hello', 'hey', 'thanks', 'help', 'info', 'news', 'support',
  'book', 'club', 'love', 'star', 'angel', 'ace', 'top', 'big', 'little', 'red', 'blue', 'green', 'black', 'white',
  'gray', 'grey', 'brown', 'gold', 'silver', 'king', 'queen', 'prince', 'major', 'guy', 'kid', 'lol', 'dev', 'ops',
  // Names that are also everyday words.
  'will', 'may', 'mark', 'bill', 'rose', 'hope', 'joy', 'grace', 'faith', 'art', 'ray', 'sky', 'sun', 'dawn', 'eve',
  'frank', 'sunny', 'holly', 'ivy', 'lily', 'iris', 'daisy', 'amber', 'ruby', 'pearl', 'crystal', 'honey', 'cash',
  'chance', 'chase', 'drew', 'gene', 'glen', 'hunter', 'miles', 'rob', 'sue', 'pat', 'don', 'nick', 'jack', 'jay',
  'kit', 'page', 'penny', 'summer', 'autumn', 'winter', 'spring', 'april', 'june', 'august', 'river', 'storm',
  'rain', 'brook', 'dale', 'wade', 'carry', 'harper', 'piper', 'reed', 'rich', 'sage', 'skye', 'stone', 'wolf',
]);

export interface NamedPerson { id: string; names: Array<string | null | undefined> }

export interface NameMatcher {
  /** Every name looked for, longest first, as one expression. Null when there are none. */
  regex: RegExp | null;
  /** Lowercased name → the person's id, or null when two people share it. */
  owners: Map<string, string | null>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings looked for for one name: itself, and its first word. */
function spellings(name: string): string[] {
  const full = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!full) return [];
  const first = full.split(' ')[0];
  return first !== full ? [full, first] : [full];
}

function lookedFor(name: string, stoplist: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  return [...name].length >= MIN_NAME_CHARS && !/^\d+$/.test(name) && !stoplist.has(lower)
    // A name made only of common words ("The Admin") is left alone too.
    && !lower.split(/[\s._-]+/).every((w) => stoplist.has(w) || w === '');
}

export function buildNameMatcher(people: NamedPerson[], opts: { stoplist?: ReadonlySet<string> } = {}): NameMatcher {
  const stoplist = opts.stoplist ?? NAME_STOPLIST;
  const owners = new Map<string, string | null>();
  const display = new Map<string, string>();
  for (const person of people) {
    const seen = new Set<string>();
    for (const n of person.names) {
      if (!n) continue;
      for (const s of spellings(n)) {
        const key = s.toLowerCase();
        if (seen.has(key) || !lookedFor(s, stoplist)) continue;
        seen.add(key);
        const owner = owners.get(key);
        if (owner === undefined) { owners.set(key, person.id); display.set(key, s); }
        else if (owner !== person.id) owners.set(key, null);
      }
    }
  }
  if (owners.size === 0) return { regex: null, owners };
  const alternatives = [...display.values()].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegExp);
  // Whole words: no letter, digit or underscore just before or after.
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return { regex, owners };
}

/** What was (or would be) replaced: the name as written, its replacement, how often. Local only. */
export type NameReplacements = Map<string, { as: string; count: number }>;

/**
 * Replace the names in `text`. `labelFor` gives a person's label; `found`
 * collects what was replaced, for the dry-run report.
 */
export function replacePlainNames(
  text: string, matcher: NameMatcher, labelFor: (id: string) => string, found?: NameReplacements,
): string {
  if (!matcher.regex) return text;
  return text.replace(matcher.regex, (match) => {
    const owner = matcher.owners.get(match.normalize('NFC').toLowerCase());
    if (owner === undefined) return match;
    const as = owner === null ? 'someone' : labelFor(owner);
    if (found) {
      const entry = found.get(match) ?? { as, count: 0 };
      entry.count++;
      found.set(match, entry);
    }
    return as;
  });
}

/** For the report: what was replaced, most frequent first. */
export function replacementList(found: NameReplacements): Array<{ name: string; as: string; count: number }> {
  return [...found.entries()]
    .map(([name, { as, count }]) => ({ name, as, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
