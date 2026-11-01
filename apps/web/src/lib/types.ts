// Row shapes returned by Supabase (see supabase/migrations) and decrypted payload shapes.
import type { Envelope } from '@kithwall/crypto';

export type Uuid = string;

export interface ProfileRow {
  id: Uuid; username: string; discoverable: boolean; display_name_public: string | null;
  sign_pub: string; kx_pub: string; key_version: number; status: 'active' | 'suspended' | 'banned';
  suspended_until: string | null; created_at: string;
  /** Set by the person's legacy contact after release: the profile shows "Remembering <name>" (lib/legacy). */
  memorialised_at?: string | null;
}

export interface AudienceRow {
  id: Uuid; owner_id: Uuid; kind: 'friends' | 'list' | 'group' | 'event' | 'conversation' | 'self';
  current_epoch: number; name_enc: unknown; created_at: string;
}

export interface FriendshipRow {
  user_a: Uuid; user_b: Uuid; status: 'pending' | 'accepted'; requested_by: Uuid;
  note: unknown; created_at: string; accepted_at: string | null;
}

export type PostKind = 'status' | 'photo' | 'link' | 'video' | 'note' | 'share';

export interface PostRow {
  id: Uuid; author_id: Uuid; wall_owner_id: Uuid | null; group_id: Uuid | null; event_id: Uuid | null;
  kind: PostKind; is_public: boolean; audience_id: Uuid | null; epoch: number | null;
  shared_post_id: Uuid | null; envelope: Envelope; created_at: string; edited_at: string | null;
  /** Scheduled posts (phase 3): visible only to the author until this time. null once published. */
  publish_at?: string | null;
  /** Disappearing posts (phase 3): the chosen timer and when the server deletes the post. */
  disappear_secs?: number | null; expires_at?: string | null;
}

export interface CommentRow {
  id: Uuid; post_id: Uuid | null; photo_id: Uuid | null; author_id: Uuid; envelope: Envelope; created_at: string;
  edited_at?: string | null;
}

export interface LikeRow {
  target_kind: 'post' | 'comment' | 'photo'; target_id: Uuid; user_id: Uuid; created_at: string;
  /** An encrypted emoji reaction (lib/social/engage); none = a heart. */
  sealed?: unknown;
}

/**
 * Reference to an encrypted file in the media bucket. Large files (videos) are stored as several
 * objects: `parts` lists their paths in order (parts[0] === path); the ciphertext is their
 * concatenation and `path` is the file id bound into every chunk's associated data.
 */
export interface FileRef {
  path: string; key: string /* b64u file key */; mime: string; w?: number; h?: number; bytes: number; parts?: string[];
  /** SHA-256 of the whole stored ciphertext (b64u, @kithwall/crypto fileDigest): checked on download, and binds the
   *  file to a message's franking commitment so it can't be swapped behind the same path. Files from before it have none. */
  sha?: string;
}

/** Click-to-play video embed (lib/embeds.ts). Validated with validEmbed() before use. */
export interface LinkEmbed { provider: 'youtube' | 'vimeo' | 'dailymotion' | 'streamable' | 'tiktok'; id: string; aspect: '16:9' | '9:16'; start?: number; hash?: string }

export interface PhotoFiles { big: FileRef; med: FileRef; thumb: FileRef }

export interface PostPayload {
  text?: string;
  link?: { url: string; title?: string; description?: string; site?: string; image?: FileRef; embed?: LinkEmbed };
  photos?: { id: Uuid; albumId: Uuid; files: PhotoFiles; caption?: string }[];
  /** Uploaded video: encrypted on device (≤ 100 MB), `duration` in seconds, `w`/`h` in pixels. */
  video?: { file: FileRef; poster?: FileRef; title?: string; duration?: number; w?: number; h?: number };
  note?: { title: string; body: string; tagged: Uuid[] };
  sharedText?: string;
  tagged?: Uuid[];
  /** A poll: 2–6 options; votes are encrypted rows in post_votes (lib/social/engage). `ends`: ISO time. */
  poll?: { question?: string; options: string[]; multi?: boolean; ends?: string };
  /** Connections mentioned with @handle (they get a notification). */
  mentions?: Uuid[];
  /**
   * Time capsule (lib/social/capsule): the real payload, timelock-encrypted to drand round `round`
   * (published at `opens`); until then nobody can read it. A capsule post carries nothing else.
   */
  capsule?: { opens: string; round: number; ct: string };
}

export interface CommentPayload { text: string; /** Kithwall 2: id of the comment this replies to (one level). */ replyTo?: string }

export interface ProfileInfo {
  name: string;
  birthday?: string;            // YYYY-MM-DD
  showBirthday?: 'full' | 'month_day' | 'none';
  sex?: string; interestedIn?: string; lookingFor?: string;
  relationship?: string; relationshipWith?: Uuid; anniversary?: string;
  hometown?: string; currentCity?: string; languages?: string; religion?: string; political?: string;
  bio?: string; quotes?: string;
  education?: { school: string; year?: string; concentration?: string; kind: 'college' | 'high_school' | 'grad' }[];
  work?: { employer: string; position?: string; city?: string; from?: string; to?: string }[];
  likes?: { music?: string; books?: string; movies?: string; tv?: string; games?: string; activities?: string; interests?: string; sports?: string; teams?: string; athletes?: string; inspirational?: string };
  contact?: { email?: string; phone?: string; im?: string; website?: string; address?: string };
  avatar?: PhotoFiles;
  featuredFriends?: Uuid[];
  friends?: Uuid[];             // my friend list, shared with my friends (unless hidden)
  hideFriends?: boolean;
  /** A post of mine shown first on my profile. */
  pinnedPost?: Uuid;
  /** Fields only my close friends may read, encrypted with that list's key (lib/social/visibility). */
  x?: { a: string; e: number; c: string };
}

export interface MessageRow {
  id: Uuid; conversation_id: Uuid; sender_id: Uuid; epoch: number; envelope: Envelope; created_at: string;
  /** Phase 3: set by the server from the chat's timer; edits; unsend tombstones; server notices (timer changes). */
  expires_at?: string | null; edited_at?: string | null; unsent_at?: string | null;
  notice?: { kind: 'timer'; secs: number | null } | null;
  /** Message franking (lib/chat/franking.ts): the sender's commitment and the server's tag binding it to the
   *  sender, chat and time. Null for server notices, unsent messages and messages from older apps. */
  frank_commit?: string | null; frank_tag?: string | null;
}
export interface MessagePayload { text: string; attachments?: FileRef[]; subject?: string }

export interface NotificationRow {
  id: Uuid; recipient_id: Uuid; actor_id: Uuid; type: string; object_kind: string | null; object_id: Uuid | null;
  sealed: unknown; created_at: string; read_at: string | null;
}
