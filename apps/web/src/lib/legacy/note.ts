// Legacy contact: sealing the farewell note (docs/v2/03-safety.md §11). Pure: every key is passed in, so this
// file is unit-tested without a session.
//
// The note is sealed twice with the signed sealed box (packages/crypto seal.ts; hybrid X25519 + ML-KEM-768
// when the recipient has a verified post-quantum key):
//   to the contact  context "legacy-note/<owner>/<contact>"   (they open it once it is released)
//   to the owner    context "legacy-note-self/<owner>"         (to read and change it later)
// Both are signed by the owner's identity key, and the context binds who wrote it and for whom, so the server
// can't hand one person's note to someone else or pass off a note as written by another person.
import { b64u, openSealed, seal, sealedSignatureValid, type Sealed } from '@kithwall/crypto';
import { decodeNote, encodeNote, noteFits, type NotePayload } from './model';

export const noteContext = (ownerId: string, contactId: string) => `legacy-note/${ownerId}/${contactId}`;
export const selfContext = (ownerId: string) => `legacy-note-self/${ownerId}`;

export interface SealedNote { note: Sealed; self: Sealed; noteKx: string }

export function sealNote(args: {
  ownerId: string; contactId: string; text: string; signPriv: Uint8Array;
  contactKxPub: Uint8Array; contactPqPub: Uint8Array | null; ownKxPub: Uint8Array; ownPqPub: Uint8Array | null; at?: string;
}): SealedNote {
  if (!noteFits(args.text)) throw new Error('note too long');
  const plaintext = encodeNote(args.text, args.at);
  const note = seal({ recipientKxPub: args.contactKxPub, recipientPqPub: args.contactPqPub, senderSignPriv: args.signPriv, context: noteContext(args.ownerId, args.contactId), plaintext });
  const self = seal({ recipientKxPub: args.ownKxPub, recipientPqPub: args.ownPqPub, senderSignPriv: args.signPriv, context: selfContext(args.ownerId), plaintext });
  return { note, self, noteKx: b64u.encode(args.contactKxPub) };
}

/**
 * Open a note sealed to me. `keys` are my current key-exchange key pair first, then earlier ones (after an
 * identity change the note may still be sealed to an older key; `noteKx` says which). Throws when the
 * signature doesn't match `senderSignPub` or nothing opens it.
 */
export function openNote(args: {
  sealed: unknown; ownerId: string; contactId: string; senderSignPub: Uint8Array;
  keys: { kxPriv: Uint8Array; kxPub: Uint8Array }[]; noteKx?: string | null;
}): NotePayload {
  return openWith(args.sealed, noteContext(args.ownerId, args.contactId), args.senderSignPub, args.keys, args.noteKx);
}

/** Open my own copy (sealed and signed by me). */
export function openSelf(args: { sealed: unknown; ownerId: string; signPub: Uint8Array; keys: { kxPriv: Uint8Array; kxPub: Uint8Array }[] }): NotePayload {
  return openWith(args.sealed, selfContext(args.ownerId), args.signPub, args.keys, null);
}

function openWith(sealed: unknown, context: string, senderSignPub: Uint8Array, keys: { kxPriv: Uint8Array; kxPub: Uint8Array }[], noteKx: string | null | undefined): NotePayload {
  if (!sealed || typeof sealed !== 'object') throw new Error('no note');
  const ordered = noteKx ? [...keys].sort((a, b) => Number(b64u.encode(b.kxPub) === noteKx) - Number(b64u.encode(a.kxPub) === noteKx)) : keys;
  let last: unknown = new Error('no key');
  for (const k of ordered) {
    try {
      return decodeNote(openSealed({ sealed: sealed as Sealed, recipientKxPriv: k.kxPriv, recipientKxPub: k.kxPub, senderSignPub, context }));
    } catch (e) { last = e; }
  }
  throw last;
}

/**
 * Should the owner's device seal the note again? Yes when the contact's trusted key-exchange key is no longer
 * the one it was sealed to, when it no longer verifies under my current signing key (my identity changed), or
 * when the contact now has a post-quantum key and the box is still classical.
 */
export function noteNeedsReseal(args: {
  sealed: unknown; noteKx: string | null; ownerId: string; contactId: string;
  mySignPub: Uint8Array; contactKxPub: Uint8Array; contactPqPub: Uint8Array | null;
}): boolean {
  if (!args.sealed || !args.noteKx) return false;
  if (args.noteKx !== b64u.encode(args.contactKxPub)) return true;
  const v = (args.sealed as Partial<Sealed>).v;
  if (args.contactPqPub && v === 1) return true;
  return !sealedSignatureValid({
    sealed: args.sealed, senderSignPub: args.mySignPub, recipientKxPub: args.contactKxPub,
    context: noteContext(args.ownerId, args.contactId), recipientPqPub: args.contactPqPub,
  });
}
