// Run: npx vitest run src/lib/legacy
// Legacy contact: the date arithmetic mirrors the database (kw.legacy_due), the note is sealed so that only
// the chosen contact (and the owner's own copy) can open it, bound to who wrote it and for whom, and the
// owner's device notices when the note must be sealed again.
import { describe, expect, it } from 'vitest';
import { b64u, generateIdentity, pqKeysFromKx } from '@kithwall/crypto';
import { addMonths, daysBetween, decodeNote, encodeNote, isLegacyMonths, legacyDueOn, NOTE_MAX, noteFits, utcDay } from './model';
import { noteNeedsReseal, openNote, openSelf, sealNote } from './note';

describe('dates', () => {
  it('adds months like Postgres does (clamping to the end of shorter months)', () => {
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2026-12-15', 12)).toBe('2027-12-15');
    expect(legacyDueOn('2026-05-31', 6)).toBe('2026-11-30');
  });
  it('counts days between calendar days', () => {
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
    expect(daysBetween('2026-12-01', '2026-11-01')).toBe(-30);
    expect(daysBetween('2027-03-27', '2027-03-28')).toBe(1);
  });
  it('knows the allowed periods and today', () => {
    expect([3, 6, 12].every(isLegacyMonths)).toBe(true);
    expect(isLegacyMonths(4)).toBe(false);
    expect(isLegacyMonths('6')).toBe(false);
    expect(utcDay(new Date('2026-11-01T23:30:00-05:00'))).toBe('2026-11-02');
  });
});

describe('note payload', () => {
  it('round-trips and pads to a coarse size', () => {
    const a = encodeNote('Thank you for everything.', '2026-11-01T00:00:00.000Z');
    const b = encodeNote('Thank you for everything, and look after the garden.', '2026-11-01T00:00:00.000Z');
    expect(a.length).toBe(1024);
    expect(b.length).toBe(a.length);
    expect(decodeNote(a)).toEqual({ v: 1, text: 'Thank you for everything.', at: '2026-11-01T00:00:00.000Z' });
    expect(encodeNote('x'.repeat(3000)).length % 512).toBe(0);
  });
  it('limits the length', () => {
    expect(noteFits('a'.repeat(NOTE_MAX))).toBe(true);
    expect(noteFits('a'.repeat(NOTE_MAX + 1))).toBe(false);
    expect(noteFits('😀'.repeat(NOTE_MAX / 2))).toBe(true);
    expect(() => decodeNote(new TextEncoder().encode('{"v":2}'))).toThrow();
  });
});

describe('sealing the note', () => {
  const owner = generateIdentity();
  const contact = generateIdentity();
  const other = generateIdentity();
  const keys = (x: typeof owner) => [{ kxPriv: x.kxPriv, kxPub: x.kxPub }];
  const pq = (x: typeof owner) => pqKeysFromKx(x.kxPriv).pub;
  const make = (contactPq: Uint8Array | null = pq(contact)) => sealNote({
    ownerId: 'u-owner', contactId: 'u-contact', text: 'With love.', signPriv: owner.signPriv,
    contactKxPub: contact.kxPub, contactPqPub: contactPq, ownKxPub: owner.kxPub, ownPqPub: pq(owner), at: '2026-11-01T00:00:00.000Z',
  });

  it('opens for the contact and for the owner, with the hybrid post-quantum box', () => {
    const s = make();
    expect(s.note.v).toBe(2);
    expect(s.noteKx).toBe(b64u.encode(contact.kxPub));
    expect(openNote({ sealed: s.note, ownerId: 'u-owner', contactId: 'u-contact', senderSignPub: owner.signPub, keys: keys(contact) }).text).toBe('With love.');
    expect(openSelf({ sealed: s.self, ownerId: 'u-owner', signPub: owner.signPub, keys: keys(owner) }).text).toBe('With love.');
  });
  it('nobody else can open it', () => {
    const s = make();
    expect(() => openNote({ sealed: s.note, ownerId: 'u-owner', contactId: 'u-contact', senderSignPub: owner.signPub, keys: keys(other) })).toThrow();
    expect(() => openNote({ sealed: s.self, ownerId: 'u-owner', contactId: 'u-contact', senderSignPub: owner.signPub, keys: keys(contact) })).toThrow();
  });
  it('is bound to its writer and its recipient', () => {
    const s = make();
    // Passed off as someone else's note, or handed to another person's id: the signature no longer matches.
    expect(() => openNote({ sealed: s.note, ownerId: 'u-owner', contactId: 'u-contact', senderSignPub: other.signPub, keys: keys(contact) })).toThrow();
    expect(() => openNote({ sealed: s.note, ownerId: 'u-other', contactId: 'u-contact', senderSignPub: owner.signPub, keys: keys(contact) })).toThrow();
    expect(() => openNote({ sealed: s.note, ownerId: 'u-owner', contactId: 'u-someone', senderSignPub: owner.signPub, keys: keys(contact) })).toThrow();
  });
  it('opens with an earlier key after the contact changed identity', () => {
    const s = make();
    const next = generateIdentity();
    const ks = [{ kxPriv: next.kxPriv, kxPub: next.kxPub }, ...keys(contact)];
    expect(openNote({ sealed: s.note, ownerId: 'u-owner', contactId: 'u-contact', senderSignPub: owner.signPub, keys: ks, noteKx: s.noteKx }).text).toBe('With love.');
  });
  it('refuses notes that are too long', () => {
    expect(() => sealNote({
      ownerId: 'a', contactId: 'b', text: 'x'.repeat(NOTE_MAX + 1), signPriv: owner.signPriv,
      contactKxPub: contact.kxPub, contactPqPub: null, ownKxPub: owner.kxPub, ownPqPub: null,
    })).toThrow(/too long/);
  });

  it('knows when to seal again', () => {
    const s = make();
    const base = { sealed: s.note, noteKx: s.noteKx, ownerId: 'u-owner', contactId: 'u-contact', mySignPub: owner.signPub, contactKxPub: contact.kxPub, contactPqPub: pq(contact) };
    expect(noteNeedsReseal(base)).toBe(false);
    const moved = generateIdentity();
    expect(noteNeedsReseal({ ...base, contactKxPub: moved.kxPub, contactPqPub: pq(moved) })).toBe(true);   // contact's key changed
    expect(noteNeedsReseal({ ...base, mySignPub: other.signPub })).toBe(true);                             // my identity changed
    const classic = make(null);
    expect(classic.note.v).toBe(1);
    expect(noteNeedsReseal({ ...base, sealed: classic.note })).toBe(true);                                 // contact now has a PQ key
    expect(noteNeedsReseal({ ...base, sealed: classic.note, contactPqPub: null })).toBe(false);
    expect(noteNeedsReseal({ ...base, sealed: null, noteKx: null })).toBe(false);                          // no note
  });
});
