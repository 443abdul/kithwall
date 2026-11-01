import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, strongPassword } from './password';

describe('strongPassword', () => {
  it('needs the minimum length', async () => {
    expect((await strongPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).ok).toBe(false);
  });
  it('knows common passwords (dictionaries loaded)', async () => {
    const s = await strongPassword('password12345');
    expect(s.score).toBeLessThan(3);
    expect(s.ok).toBe(false);
  });
  it('refuses a merely "good" password (score 3, security review L12)', async () => {
    const s = await strongPassword('sunflower2024!');
    expect(s.score).toBe(3);
    expect(s.ok).toBe(false);
    expect(s.hint).toBeTruthy();
  });
  it('accepts a passphrase of uncommon words', async () => {
    const s = await strongPassword('copper lantern orbit mango');
    expect(s.score).toBe(4);
    expect(s.ok).toBe(true);
  });
  it('counts the handle against the password', async () => {
    expect((await strongPassword('arehman arehman 2024', ['@arehman'])).ok).toBe(false);
  });
});
