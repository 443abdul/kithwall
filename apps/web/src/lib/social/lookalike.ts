// Impersonation check, entirely on this device: does a stranger's name or @handle look like one of my
// connections'? The "relative needs money urgently" scam works by copying a name and photo. Names are
// reduced to a "skeleton" (Unicode TR39 style, simplified): compatibility-normalised, lower-cased, accents
// dropped, look-alike letters from other scripts (Cyrillic а, Greek ο…) and digits (0, 1, 3, 5) folded to
// the Latin letter they imitate, "rn" read as "m", spaces and punctuation removed. Two people look alike
// when their skeletons are equal, or differ by one letter in names of at least five letters.

const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ѕ': 's', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  // digits and symbols that pass for letters
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '|': 'l',
  // Latin look-alikes
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ß': 'ss',
  // Arabic-script variants that render the same in Urdu / Persian / Arabic
  'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
};

export function skeleton(name: string): string {
  let s = name.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  s = [...s].map((c) => CONFUSABLE[c] ?? c).join('');
  // 'i' and 'l' are indistinguishable in many fonts; so are 'rn'/'m' and 'vv'/'w'.
  s = s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[il]/g, 'l');
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export interface NamedPerson { id: string; name?: string | null; username?: string | null }

/** The connection this person seems to imitate, if any (never themselves). */
export function lookalikeOf(person: NamedPerson, connections: NamedPerson[]): NamedPerson | null {
  const mine = [person.name, person.username].filter((x): x is string => !!x).map(skeleton).filter((x) => x.length >= 3);
  if (!mine.length) return null;
  for (const c of connections) {
    if (c.id === person.id) continue;
    for (const theirs of [c.name, c.username].filter((x): x is string => !!x).map(skeleton)) {
      if (theirs.length < 3) continue;
      for (const m of mine) {
        if (m === theirs || (Math.min(m.length, theirs.length) >= 5 && withinOne(m, theirs))) return c;
      }
    }
  }
  return null;
}
