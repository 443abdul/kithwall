import { describe, expect, it } from 'vitest';
import { frankingBody, frankMatches } from '@kithwall/crypto';
import type { MessageRow } from '../types';
import { checkFrank, frankEvidence, frankPayload, withoutFk } from './franking';

const ids = { id: '00000000-0000-0000-0000-0000000000d1', conversation_id: '00000000-0000-0000-0000-0000000000c1', sender_id: '00000000-0000-0000-0000-0000000000e1' };
const row = (commit: string | null, extra: Partial<MessageRow> = {}): MessageRow => ({
  ...ids, epoch: 1, envelope: { v: 1, sig: '' }, created_at: '2026-11-02T10:00:00.123456+00:00', frank_commit: commit, frank_tag: 'tag', ...extra,
});
const photo = { path: 'a/b', key: 'k', mime: 'image/jpeg', bytes: 3, sha: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0' };

describe('message franking (chat)', () => {
  it('a sent message verifies on the recipient\'s side', () => {
    const { payload, commit } = frankPayload(ids, { text: 'see you', attachments: [photo] });
    expect(payload.fk).toHaveLength(43);
    // What the recipient decrypts is the JSON round trip of what was sealed.
    const opened = JSON.parse(JSON.stringify(payload)) as object;
    expect(checkFrank(row(commit), opened)).toBe('ok');
  });

  it('tampering with the content, an attachment, or the commitment shows as bad, never as genuine', () => {
    const { payload, commit } = frankPayload(ids, { text: 'see you', attachments: [photo] });
    expect(checkFrank(row(commit), { ...payload, text: 'see you never' })).toBe('bad');
    expect(checkFrank(row(commit), { ...payload, attachments: [{ ...photo, sha: 'swapped' }] })).toBe('bad');
    expect(checkFrank(row(frankPayload(ids, { text: 'see you' }).commit), payload)).toBe('bad');
    expect(checkFrank(row(commit), withoutFk(payload))).toBe('bad');
    expect(checkFrank(row(commit, { sender_id: '00000000-0000-0000-0000-0000000000e2' }), payload)).toBe('bad');
    expect(checkFrank(row(commit, { conversation_id: '00000000-0000-0000-0000-0000000000c2' }), payload)).toBe('bad');
  });

  it('messages without a commitment (older apps, server notices) are "none"', () => {
    expect(checkFrank(row(null), { text: 'hi' })).toBe('none');
    expect(frankEvidence(row(null), { text: 'hi' })).toBeNull();
  });

  it('an edit gets a fresh key; the old commitment no longer matches', () => {
    const first = frankPayload(ids, { text: 'draft' });
    const edited = frankPayload(ids, { ...first.payload, text: 'final' });
    expect(edited.payload.fk).not.toBe(first.payload.fk);
    expect(checkFrank(row(edited.commit), edited.payload)).toBe('ok');
    expect(checkFrank(row(first.commit), edited.payload)).toBe('bad');
  });

  it('report evidence is exactly what the server checks', () => {
    const { payload, commit } = frankPayload(ids, { text: 'threat', voice: { secs: 3 } });
    const ev = frankEvidence(row(commit, { edited_at: '2026-11-02T11:00:00+00:00' }), payload);
    expect(ev).not.toBeNull();
    expect(ev!.body).toBe(frankingBody({ conversationId: ids.conversation_id, messageId: ids.id, senderId: ids.sender_id, payload: { text: 'threat', voice: { secs: 3 } } }));
    expect(ev!.body).not.toContain(payload.fk);
    expect(frankMatches(ev!.fk, ev!.body, ev!.commit)).toBe(true);
    expect(ev).toMatchObject({ commit, tag: 'tag', conv: ids.conversation_id, sender: ids.sender_id, at: '2026-11-02T11:00:00+00:00' });
  });
});
