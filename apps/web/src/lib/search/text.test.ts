import { describe, expect, it } from 'vitest';
import { excerpt, findRanges, foldWithMap, matches, prepare, queryWords } from './text';

const find = (text: string, query: string) => matches(prepare(text), queryWords(query));
const marked = (text: string, query: string) => findRanges(text, queryWords(query)).map((r) => text.slice(r.start, r.end));

describe('folding', () => {
  it('ignores case, accents and width', () => {
    expect(prepare('Héllo  WORLD, ça va?')).toBe(' hello world ca va ');
    expect(prepare('ＡＢＣ １２３')).toBe(' abc 123 ');
    expect(prepare('İstanbul ISPARTA ılık')).toBe(' istanbul isparta ilik ');
    expect(prepare('Straße Ærø łódź')).toBe(' strasse aero lodz ');
    expect(prepare('Ёлка и ёж')).toBe(' елка и еж ');
  });

  it('unifies Arabic-script letters and drops harakat and tatweel', () => {
    // Fully vowelled Arabic = bare letters.
    expect(prepare('كَتَبَ الطَّالِبُ')).toBe(prepare('كتب الطالب'));
    expect(prepare('كتـــاب')).toBe(prepare('كتاب'));
    // Arabic yeh / alef maksura / Farsi yeh, and kaf / keheh: Urdu and Arabic keyboards agree.
    expect(prepare('علي')).toBe(prepare('علی'));
    expect(prepare('على')).toBe(prepare('علی'));
    expect(prepare('كراچی')).toBe(prepare('کراچی'));
    // Heh forms and teh marbuta.
    expect(prepare('مدرسة')).toBe(prepare('مدرسه'));
    expect(prepare('ہے')).toBe(prepare('هے'));
    expect(prepare('بھائی')).toBe(prepare('بهائی'));
    // Alef forms, hamza carriers.
    expect(prepare('أحمد إبراهيم آمنة')).toBe(prepare('احمد ابراهيم امنة'));
    expect(prepare('مسؤول')).toBe(prepare('مسوول'));
    // Persian zero-width non-joiner.
    expect(prepare('می‌خواهم')).toBe(prepare('میخواهم'));
  });

  it('keeps Hindi and Bengali vowel signs, drops the nukta', () => {
    expect(prepare('किताब')).toBe(' किताब ');
    expect(prepare('किताब')).not.toBe(prepare('कतब'));
    expect(prepare('ज़रूरी')).toBe(prepare('जरूरी'));
    expect(prepare('क़लम')).toBe(prepare('कलम'));
    expect(prepare('माँ')).toBe(prepare('मां'));
    expect(prepare('বাংলা ভাষা')).toBe(' বাংলা ভাষা ');
    expect(prepare('বড়')).toBe(prepare('বড'));
  });

  it('reads digits of every script as the same number', () => {
    expect(prepare('١٢٣ ۴۵۶ ७८९ ০১২')).toBe(' 123 456 789 012 ');
  });

  it('treats punctuation, emoji and symbols as word breaks', () => {
    expect(prepare("don't-stop_me@now! 😀 a/b")).toBe(' don t stop me now a b ');
    expect(prepare('、。「你好」，世界！')).toBe(' 你好 世界 ');
    expect(prepare('')).toBe(' ');
    expect(prepare('   \n\t ')).toBe(' ');
  });

  it('maps every folded character back to its place in the original', () => {
    const original = 'Ça va, Zoë?';
    const f = foldWithMap(original);
    expect(f.text).toBe('ca va  zoe ');
    expect(f.text.length).toBe(f.start.length);
    for (let i = 0; i < f.text.length; i++) expect(f.end[i]!).toBeGreaterThan(f.start[i]!);
    expect(original.slice(f.start[7]!, f.end[9]!)).toBe('Zoë');
    // One original character can fold to two (ß) or to none (a combining mark).
    const g = foldWithMap('Maße');
    expect(g.text).toBe('masse');
    expect(g.start).toEqual([0, 1, 2, 2, 3]);
  });
});

describe('matching', () => {
  it('needs every word, in any order, each at the start of a word', () => {
    expect(find('Dinner at Karachi Kitchen tonight', 'kar')).toBe(true);
    expect(find('Dinner at Karachi Kitchen tonight', 'tonight dinner')).toBe(true);
    expect(find('Dinner at Karachi Kitchen tonight', 'achi')).toBe(false);
    expect(find('Dinner at Karachi Kitchen tonight', 'dinner lunch')).toBe(false);
    expect(find('the party starts at nine', 'art')).toBe(false);
    expect(find('Call me on 0300-1234567', '1234567')).toBe(true);
    expect(find('anything', '')).toBe(false);
    expect(find('anything', '  ,. ')).toBe(false);
  });

  it('is forgiving about how people type', () => {
    expect(find('Voilà, le café est prêt', 'cafe pret')).toBe(true);
    expect(find('cafe', 'CAFÉ')).toBe(true);
    expect(find('İstanbul güzel', 'istanbul guzel')).toBe(true);
    expect(find('Привет, как дела?', 'ПРИВЕТ')).toBe(true);
    expect(find('ज़रूरी बात है', 'जरूरी')).toBe(true);
    expect(find('আমি বাংলায় গান গাই', 'বাংলা')).toBe(true);
    expect(find('٣ تذاكر', '3')).toBe(true);
  });

  it('finds Arabic-script words with attached articles and prepositions', () => {
    expect(find('قرأت الكتاب أمس', 'كتاب')).toBe(true);
    expect(find('ذهبنا بالسيارة إلى المدرسة', 'سيارة مدرسة')).toBe(true);
    expect(find('کل ملاقات ہوگی کراچی میں', 'كراچي')).toBe(true);
    expect(find('فردا می‌خواهم بیایم', 'میخواهم')).toBe(true);
    expect(find('کتاب‌ها را آوردم', 'کتاب')).toBe(true);
    // Two letters or fewer: only at the start of a word (otherwise almost everything would match).
    expect(find('قرأت الكتاب', 'تا')).toBe(false);
    expect(find('تاريخ اليوم', 'تا')).toBe(true);
  });

  it('finds Chinese, Japanese and Thai text anywhere (no spaces between words)', () => {
    expect(find('我们明天去北京大学参观', '北京')).toBe(true);
    expect(find('我们明天去北京大学参观', '大学 明天')).toBe(true);
    expect(find('我们明天去北京大学参观', '上海')).toBe(false);
    expect(find('明日は東京タワーに行きます', 'タワー')).toBe(true);
    expect(find('พรุ่งนี้ไปกรุงเทพด้วยกัน', 'กรุงเทพ')).toBe(true);
    // A single character is too little to look for inside words; it must begin one.
    expect(find('我们明天去北京', '京')).toBe(false);
    expect(find('京都很美', '京')).toBe(true);
  });

  it('limits a query to eight different words', () => {
    expect(queryWords('a b c d e f g h i j').map((w) => w.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(queryWords('same same SAME').map((w) => w.text)).toEqual(['same']);
  });
});

describe('highlighting', () => {
  it('marks the matching part of the original text, accents and all', () => {
    expect(marked('Voilà, le Café est prêt', 'cafe pre')).toEqual(['Café', 'prê']);
    expect(marked('Dinner at Karachi Kitchen', 'k')).toEqual(['K', 'K']);
    expect(marked('كَتَبَ الطَّالِبُ الدَّرْسَ', 'طالب')).toEqual(['طَّالِبُ']);
    expect(marked('我们明天去北京大学', '北京')).toEqual(['北京']);
    expect(marked('ज़रूरी बात', 'जरूरी')).toEqual(['ज़रूरी']);
    expect(marked('Maße und Gewichte', 'masse')).toEqual(['Maße']);
    expect(marked('nothing here', 'zzz')).toEqual([]);
  });

  it('merges overlapping matches', () => {
    expect(marked('banana bandana', 'ban bana')).toEqual(['bana', 'ban']);
    expect(marked('北京北京大学', '北京 京北')).toEqual(['北京北京']);
  });

  it('cuts an excerpt around the first match', () => {
    const long = `${'Lorem ipsum dolor sit amet. '.repeat(12)}We meet at the old Bridge at noon. ${'Consectetur adipiscing elit. '.repeat(12)}`;
    const pieces = excerpt(long, queryWords('bridge'), 100);
    expect(pieces[0]).toEqual({ text: '…', hit: false });
    expect(pieces[pieces.length - 1]).toEqual({ text: '…', hit: false });
    expect(pieces.filter((p) => p.hit).map((p) => p.text)).toEqual(['Bridge']);
    expect(pieces.map((p) => p.text).join('').length).toBeLessThan(130);
    // Short text: all of it, no ellipsis, line breaks as spaces.
    expect(excerpt('Hello\nthere world', queryWords('there'))).toEqual([{ text: 'Hello ', hit: false }, { text: 'there', hit: true }, { text: ' world', hit: false }]);
    // No match in the text (the match was in another field): the beginning.
    expect(excerpt('Just some text', queryWords('zzz'))).toEqual([{ text: 'Just some text', hit: false }]);
  });

  it("doesn't cut an emoji or a marked letter in half", () => {
    const text = `${'😀'.repeat(60)} target ${'😀'.repeat(60)}`;
    for (const p of excerpt(text, queryWords('target'), 40)) expect(p.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });
});
