import { describe, expect, it } from 'vitest';
import { lookalikeOf, skeleton } from './lookalike';

const friends = [
  { id: '1', name: 'Ayesha Khan', username: 'ayesha.k' },
  { id: '2', name: 'Ammi', username: 'ammi' },
  { id: '3', name: 'عائشہ', username: 'aisha.ur' },
];

describe('look-alike names', () => {
  it('folds other scripts, digits, accents and rn/m into the same skeleton', () => {
    expect(skeleton('Аyеsha Кhan')).toBe(skeleton('Ayesha Khan')); // Cyrillic А, е, К
    expect(skeleton('Ay3sha_Khan')).toBe(skeleton('Ayesha Khan'));
    expect(skeleton('Ayésha Khan')).toBe(skeleton('Ayesha Khan'));
    expect(skeleton('arnmi')).toBe(skeleton('ammi'));
  });
  it('flags copies and near-copies of a connection, never the connection itself', () => {
    expect(lookalikeOf({ id: 'x', name: 'Ayesha  Khan', username: 'ayesha.k2' }, friends)?.id).toBe('1');
    expect(lookalikeOf({ id: 'x', name: 'Ayeshaa Khan' }, friends)?.id).toBe('1');
    expect(lookalikeOf({ id: 'x', username: 'amrni' }, friends)?.id).toBe('2');
    expect(lookalikeOf({ id: '1', name: 'Ayesha Khan' }, friends)).toBeNull();
  });
  it('leaves different people alone', () => {
    expect(lookalikeOf({ id: 'x', name: 'Bilal Ahmed', username: 'bilal' }, friends)).toBeNull();
    expect(lookalikeOf({ id: 'x', name: 'Ali' }, [{ id: '9', name: 'Alia' }])).toBeNull(); // too short for fuzzy matching
  });
});
