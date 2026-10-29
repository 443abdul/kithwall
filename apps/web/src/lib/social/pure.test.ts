import { describe, expect, it } from 'vitest';
import { newSymmetricKey } from '@kithwall/crypto';
import { handlesIn, tally } from './pure';
import { openExtra, sealExtra, splitProfile } from './profileTiers';
import type { ProfileInfo } from '../types';

describe('handlesIn', () => {
  it('finds @handles, lower-cased, without trailing punctuation, once each', () => {
    expect(handlesIn('Thanks @Sara.Khan and @omar.s! Also @sara.khan.')).toEqual(['sara.khan', 'omar.s']);
  });
  it('ignores emails and handles glued to words', () => {
    expect(handlesIn('mail me at dan@example.com or word@handle')).toEqual([]);
    expect(handlesIn('@a is too short, (@bob) works')).toEqual(['bob']);
  });
});

describe('tally', () => {
  it('counts each choice and each voter once', () => {
    expect(tally([{ voter: 'a', choices: [0] }, { voter: 'b', choices: [0, 2] }], 3)).toEqual({ counts: [2, 0, 1], voters: 2 });
  });
});

describe('profile tiers', () => {
  const info: ProfileInfo = { name: 'Sara', bio: 'hi', currentCity: 'Lahore', birthday: '1990-04-02', showBirthday: 'full', languages: 'Urdu' };
  it('splits fields by tier and keeps the birthday display setting with the birthday', () => {
    const { open, close, mine } = splitProfile(info, { currentCity: 'close', birthday: 'me' });
    expect(open).toEqual({ name: 'Sara', bio: 'hi', languages: 'Urdu' });
    expect(close).toEqual({ currentCity: 'Lahore' });
    expect(mine).toEqual({ birthday: '1990-04-02', showBirthday: 'full' });
  });
  it('seals close-friends fields so only the list key opens them, and only for that owner and epoch', () => {
    const key = newSymmetricKey();
    const x = sealExtra('user-1', 'aud-1', 3, key, { currentCity: 'Lahore' });
    expect(openExtra('user-1', x, (a, e) => (a === 'aud-1' && e === 3 ? key : null))).toEqual({ currentCity: 'Lahore' });
    expect(openExtra('user-1', x, () => null)).toBeNull();
    expect(openExtra('user-2', x, () => key)).toBeNull();
    expect(openExtra('user-1', { ...x, e: 4 }, () => key)).toBeNull();
  });
  it('drops anything that is not a profile field', () => {
    const key = newSymmetricKey();
    const x = sealExtra('u', 'a', 1, key, { name: 'Mallory', currentCity: 'X' } as Partial<ProfileInfo>);
    expect(openExtra('u', x, () => key)).toEqual({ currentCity: 'X' });
  });
});
