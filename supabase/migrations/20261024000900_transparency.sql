-- Kithwall 2 phase 3: transparency ("What Kithwall knows about you", docs/v2/03-transparency.md).
--
-- 1. A maintained DATA MAP: every column of every table in the public and kw schemas is classified as
--      id          identifiers and links between rows (who / which item)
--      time        timestamps (when)
--      plaintext   other values the server can read (flags, sizes, roles, public keys, labels)
--      ciphertext  encrypted on the person's device; the server cannot read it
--      hashed      one-way hashes or random tokens that reveal nothing on their own
--    and every table gets a category and (for tables that hold rows about a person) the predicate that
--    finds that person's rows. supabase/tests/transparency.test.sql FAILS if any column is missing from
--    the map, so every future migration that adds a table or column must classify it here:
--      insert into kw.data_map_tables (...) values (...);
--      insert into kw.data_map_columns (table_name, column_name, class) values (...);
--
-- 2. public.transparency_report(): SECURITY DEFINER, for the caller only. It returns, live from the
--    server's actual rows, the account facts (auth timestamps, synthetic vs real email, passkeys, sign-in
--    sessions), the number of rows held about the caller in each table with their first/last time, the
--    encrypted files they stored, and for each table which columns are readable and which are ciphertext.

-- ---------------------------------------------------------------------------------------------
-- The map
-- ---------------------------------------------------------------------------------------------
create table kw.data_map_tables (
  table_name text primary key check (table_name ~ '^(public|kw)\.[a-z_]+$'),
  category text not null check (category in ('account', 'content', 'social', 'messages', 'activity', 'housekeeping', 'legacy', 'system')),
  -- Boolean SQL over the row alias "t" and the caller's id "$1"; null = never holds rows about a person.
  -- Only rows the person may know about: e.g. blocks count those YOU made, never who blocked you.
  owner_pred text,
  time_col text,
  size_col text,
  retention text not null default 'Until you delete it or your account',
  note text
);

create table kw.data_map_columns (
  table_name text not null references kw.data_map_tables (table_name) on delete cascade,
  column_name text not null,
  class text not null check (class in ('id', 'time', 'plaintext', 'ciphertext', 'hashed')),
  note text,
  primary key (table_name, column_name)
);

revoke all on kw.data_map_tables, kw.data_map_columns from public, anon, authenticated;

insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  -- account & keys
  ('public.profiles', 'account', 't.id = $1', 'created_at', null, 'Until you delete your account', 'Your @handle and public keys. Your name and profile details are in profile_info, encrypted.'),
  ('public.profile_info', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', null),
  ('public.key_bundles', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', 'Your private keys, wrapped so only your passkey, passphrase or recovery key can open them.'),
  ('public.key_changes', 'account', 't.user_id = $1', 'created_at', null, 'Until you delete your account', null),
  ('public.passkeys', 'account', 't.user_id = $1', 'created_at', null, 'Until you remove the passkey or delete your account', null),
  ('public.passkey_wraps', 'account', 't.user_id = $1', 'created_at', null, 'Until you remove the passkey or delete your account', null),
  ('public.passkey_users', 'account', 't.user_id = $1', 'created_at', null, 'Until you delete your account', null),
  ('public.account_security', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', null),
  ('public.privacy_prefs', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', null),
  ('public.push_preferences', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', null),
  ('public.push_subscriptions', 'account', 't.user_id = $1', 'created_at', null, 'Until you turn notifications off on that device', null),
  ('public.vault', 'account', 't.user_id = $1', 'updated_at', null, 'Until you delete your account', 'Your settings and private lists, encrypted.'),
  ('public.staff_roles', 'account', 't.user_id = $1', 'created_at', null, 'While you are a moderator', null),
  ('public.recovery_shares', 'account', 't.owner_id = $1 or t.trustee_id = $1', 'created_at', null, 'Until recovery is set up again or an account is deleted', null),
  -- content
  ('public.posts', 'content', 't.author_id = $1 or t.wall_owner_id = $1', 'created_at', null, 'Until you delete it or your account', null),
  ('public.comments', 'content', 't.author_id = $1', 'created_at', null, 'Until you delete it or your account', null),
  ('public.likes', 'content', 't.user_id = $1', 'created_at', null, 'Until you undo it or delete your account', null),
  ('public.stories', 'content', 't.author_id = $1', 'created_at', null, '24 hours', null),
  ('public.story_views', 'content', 't.viewer_id = $1', 'viewed_at', null, 'Deleted with the story (24 hours)', null),
  ('public.albums', 'content', 't.owner_id = $1', 'created_at', null, 'Until you delete it or your account', null),
  ('public.photos', 'content', 't.owner_id = $1', 'created_at', null, 'Until you delete it or your account', null),
  ('public.media_objects', 'content', 't.owner_id = $1', 'created_at', 'bytes', 'Until you delete the item or your account', 'Encrypted files: only their size and when they were uploaded are visible.'),
  ('public.tag_notices', 'content', 't.tagged_id = $1 or t.tagger_id = $1', 'created_at', null, 'Until the tag is removed', null),
  -- social graph, circles, events
  ('public.friendships', 'social', 't.user_a = $1 or t.user_b = $1', 'created_at', null, 'Until you disconnect or delete your account', null),
  ('public.blocks', 'social', 't.blocker = $1', 'created_at', null, 'Until you unblock', null),
  ('public.audiences', 'social', 't.owner_id = $1', 'created_at', null, 'Until you delete your account', 'Your connections list, circles, events and chats are each an audience with its own key.'),
  ('public.audience_members', 'social', 't.member_id = $1', 'created_at', null, 'Until you leave', null),
  ('public.audience_keys', 'social', 't.recipient_id = $1 or t.sealed_by = $1', 'created_at', null, 'Until the circle, event or chat is deleted', null),
  ('public.groups', 'social', 't.creator_id = $1', 'created_at', null, 'Until the circle is deleted', null),
  ('public.events', 'social', 't.host_id = $1', 'created_at', null, 'Until the event is deleted', null),
  ('public.invites', 'social', 't.inviter_id = $1', 'created_at', null, 'Until it expires or is used up', null),
  -- messages
  ('public.conversations', 'messages', 't.created_by = $1 or exists (select 1 from public.audience_members m where m.audience_id = t.audience_id and m.member_id = $1)', 'created_at', null, 'Until everyone leaves or the chat is deleted', null),
  ('public.messages', 'messages', 't.sender_id = $1', 'created_at', null, 'Until it is unsent, disappears or your account is deleted', 'Messages you sent.'),
  ('public.message_reactions', 'messages', 't.user_id = $1', 'created_at', null, 'Until you remove it', null),
  ('public.conversation_reads', 'messages', 't.user_id = $1', 'last_read_at', null, 'Until you leave the chat', null),
  -- activity & reports
  ('public.notifications', 'activity', 't.recipient_id = $1', 'created_at', null, '90 days', null),
  ('public.reports', 'activity', 't.reporter_id = $1', 'created_at', null, '1 year after a decision', 'Reports you made. The reporter discloses the reported content to moderators on purpose.'),
  ('public.moderation_actions', 'activity', 't.target_user_id = $1', 'created_at', null, '1 year', 'Moderation decisions about your account.'),
  ('public.recovery_requests', 'activity', 't.owner_id = $1', 'created_at', null, '7 days after it closes', null),
  ('public.recovery_responses', 'activity', 't.trustee_id = $1', 'created_at', null, '7 days after the request closes', null),
  -- short-lived housekeeping
  ('public.key_challenges', 'housekeeping', 't.user_id = $1', 'created_at', null, 'Short-lived one-time confirmations', null),
  ('public.webauthn_challenges', 'housekeeping', 't.user_id = $1 or t.new_user_id = $1', 'created_at', null, 'Deleted an hour after they expire', null),
  ('public.notice_email_verifications', 'housekeeping', 't.user_id = $1', 'created_at', null, 'Deleted a day after they expire', null),
  ('public.notice_emails', 'housekeeping', 't.user_id = $1', 'sent_at', null, 'Until you delete your account', 'Which content-free notices were emailed (never their text).'),
  ('public.account_deletion_requests', 'housekeeping', 't.user_id = $1', 'requested_at', null, 'Until the deletion runs or is cancelled', null),
  ('kw.rate_events', 'housekeeping', 't.user_id = $1', 'at', null, '7 days, for rate limits', 'Counts of actions (not their content) used for spam limits.'),
  -- v1 (2010) features kept only until their export is offered (docs/v2/02-cleanup.md §4)
  ('public.pokes', 'legacy', 't.from_id = $1 or t.to_id = $1', 'created_at', null, 'Until v1 data is retired', null),
  ('public.pages', 'legacy', 't.owner_id = $1', 'created_at', null, 'Until v1 data is retired', 'Public v1 Pages.'),
  ('public.page_likes', 'legacy', 't.user_id = $1', 'created_at', null, 'Until v1 data is retired', null),
  ('public.poll_votes', 'legacy', 't.voter_id = $1', 'created_at', null, 'Until v1 data is retired', null),
  ('public.game_state', 'legacy', 't.user_id = $1', 'updated_at', null, 'Until v1 data is retired', null),
  ('public.game_actions', 'legacy', 't.from_id = $1 or t.to_id = $1', 'created_at', null, 'Until v1 data is retired', null),
  -- service tables that hold nothing about a person
  ('public.app_settings', 'system', null, null, null, 'Service settings', null),
  ('public.altcha_spent', 'system', null, null, null, 'Spent anti-spam puzzles, not linked to any account', null),
  ('kw.push_config', 'system', null, null, null, 'Service settings', null),
  ('kw.data_map_tables', 'system', null, null, null, 'This map', null),
  ('kw.data_map_columns', 'system', null, null, null, 'This map', null);

insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.profiles', 'id', 'id', null), ('public.profiles', 'username', 'plaintext', 'your @handle'),
  ('public.profiles', 'discoverable', 'plaintext', null), ('public.profiles', 'display_name_public', 'plaintext', 'only if you joined the people directory'),
  ('public.profiles', 'sign_pub', 'plaintext', 'public key'), ('public.profiles', 'kx_pub', 'plaintext', 'public key'),
  ('public.profiles', 'key_version', 'plaintext', null), ('public.profiles', 'status', 'plaintext', null),
  ('public.profiles', 'suspended_until', 'time', null), ('public.profiles', 'created_at', 'time', null),

  ('public.profile_info', 'user_id', 'id', null), ('public.profile_info', 'audience_id', 'id', null), ('public.profile_info', 'epoch', 'plaintext', null),
  ('public.profile_info', 'envelope', 'ciphertext', 'name, photo, bio and profile details'), ('public.profile_info', 'updated_at', 'time', null),

  ('public.key_bundles', 'user_id', 'id', null), ('public.key_bundles', 'bundle', 'ciphertext', 'wrapped private keys (plus your public keys)'), ('public.key_bundles', 'updated_at', 'time', null),
  ('public.key_changes', 'id', 'id', null), ('public.key_changes', 'user_id', 'id', null), ('public.key_changes', 'change', 'plaintext', 'new public keys'),
  ('public.key_changes', 'sig', 'plaintext', 'signature by the old key'), ('public.key_changes', 'created_at', 'time', null),

  ('public.passkeys', 'id', 'id', null), ('public.passkeys', 'user_id', 'id', null), ('public.passkeys', 'credential_id', 'plaintext', null),
  ('public.passkeys', 'public_key', 'plaintext', 'passkey public key'), ('public.passkeys', 'counter', 'plaintext', null), ('public.passkeys', 'transports', 'plaintext', null),
  ('public.passkeys', 'backed_up', 'plaintext', 'whether it syncs'), ('public.passkeys', 'label', 'plaintext', 'e.g. "Chrome on Android"'),
  ('public.passkeys', 'created_at', 'time', null), ('public.passkeys', 'last_used_at', 'time', null),
  ('public.passkey_wraps', 'passkey_id', 'id', null), ('public.passkey_wraps', 'user_id', 'id', null), ('public.passkey_wraps', 'prf_salt', 'plaintext', 'random salt'),
  ('public.passkey_wraps', 'amk_wrap', 'ciphertext', 'your account key, wrapped by the passkey'), ('public.passkey_wraps', 'created_at', 'time', null),
  ('public.passkey_users', 'user_id', 'id', null), ('public.passkey_users', 'webauthn_user_id', 'hashed', 'random'), ('public.passkey_users', 'created_at', 'time', null),

  ('public.account_security', 'user_id', 'id', null), ('public.account_security', 'recovery_saved_at', 'time', null),
  ('public.account_security', 'notice_email', 'plaintext', 'optional notice address'), ('public.account_security', 'notice_email_verified_at', 'time', null),
  ('public.account_security', 'updated_at', 'time', null),
  ('public.privacy_prefs', 'user_id', 'id', null), ('public.privacy_prefs', 'read_receipts', 'plaintext', null),
  ('public.privacy_prefs', 'requests_from', 'plaintext', null), ('public.privacy_prefs', 'updated_at', 'time', null),
  ('public.push_preferences', 'user_id', 'id', null), ('public.push_preferences', 'messages', 'plaintext', null), ('public.push_preferences', 'activity', 'plaintext', null),
  ('public.push_preferences', 'friend_requests', 'plaintext', null), ('public.push_preferences', 'pokes', 'plaintext', null), ('public.push_preferences', 'invites', 'plaintext', null),
  ('public.push_preferences', 'security', 'plaintext', null), ('public.push_preferences', 'updated_at', 'time', null),
  ('public.push_subscriptions', 'id', 'id', null), ('public.push_subscriptions', 'user_id', 'id', null), ('public.push_subscriptions', 'endpoint', 'plaintext', 'push service address'),
  ('public.push_subscriptions', 'p256dh', 'plaintext', 'push encryption public key'), ('public.push_subscriptions', 'auth', 'hashed', 'push secret'),
  ('public.push_subscriptions', 'user_agent', 'plaintext', 'browser name'), ('public.push_subscriptions', 'created_at', 'time', null), ('public.push_subscriptions', 'last_success_at', 'time', null),
  ('public.vault', 'user_id', 'id', null), ('public.vault', 'blob', 'ciphertext', 'settings, verified contacts, private lists'), ('public.vault', 'updated_at', 'time', null),
  ('public.staff_roles', 'user_id', 'id', null), ('public.staff_roles', 'role', 'plaintext', null), ('public.staff_roles', 'granted_by', 'id', null), ('public.staff_roles', 'created_at', 'time', null),
  ('public.recovery_shares', 'owner_id', 'id', null), ('public.recovery_shares', 'trustee_id', 'id', null), ('public.recovery_shares', 'setup_id', 'id', null),
  ('public.recovery_shares', 'threshold', 'plaintext', null), ('public.recovery_shares', 'sealed', 'ciphertext', 'a piece of your recovery key'), ('public.recovery_shares', 'created_at', 'time', null),

  ('public.posts', 'id', 'id', null), ('public.posts', 'author_id', 'id', null), ('public.posts', 'wall_owner_id', 'id', null), ('public.posts', 'group_id', 'id', null),
  ('public.posts', 'event_id', 'id', null), ('public.posts', 'page_id', 'id', null), ('public.posts', 'kind', 'plaintext', 'status, photo, note…'),
  ('public.posts', 'is_public', 'plaintext', null), ('public.posts', 'audience_id', 'id', null), ('public.posts', 'epoch', 'plaintext', null),
  ('public.posts', 'shared_post_id', 'id', null), ('public.posts', 'envelope', 'ciphertext', 'text, photos, links, tags (signed, not encrypted only for Public posts)'),
  ('public.posts', 'created_at', 'time', null), ('public.posts', 'edited_at', 'time', null),
  ('public.comments', 'id', 'id', null), ('public.comments', 'post_id', 'id', null), ('public.comments', 'photo_id', 'id', null), ('public.comments', 'author_id', 'id', null),
  ('public.comments', 'envelope', 'ciphertext', 'what you wrote'), ('public.comments', 'created_at', 'time', null),
  ('public.likes', 'target_kind', 'plaintext', null), ('public.likes', 'target_id', 'id', null), ('public.likes', 'user_id', 'id', null), ('public.likes', 'created_at', 'time', null),
  ('public.stories', 'id', 'id', null), ('public.stories', 'author_id', 'id', null), ('public.stories', 'audience_id', 'id', null), ('public.stories', 'epoch', 'plaintext', null),
  ('public.stories', 'group_id', 'id', null), ('public.stories', 'envelope', 'ciphertext', 'the story text or photo'), ('public.stories', 'created_at', 'time', null), ('public.stories', 'expires_at', 'time', null),
  ('public.story_views', 'story_id', 'id', null), ('public.story_views', 'viewer_id', 'id', null), ('public.story_views', 'viewed_at', 'time', null),
  ('public.albums', 'id', 'id', null), ('public.albums', 'owner_id', 'id', null), ('public.albums', 'is_public', 'plaintext', null), ('public.albums', 'audience_id', 'id', null),
  ('public.albums', 'epoch', 'plaintext', null), ('public.albums', 'envelope', 'ciphertext', 'album name and description'), ('public.albums', 'created_at', 'time', null), ('public.albums', 'updated_at', 'time', null),
  ('public.photos', 'id', 'id', null), ('public.photos', 'album_id', 'id', null), ('public.photos', 'owner_id', 'id', null), ('public.photos', 'position', 'plaintext', null),
  ('public.photos', 'is_public', 'plaintext', null), ('public.photos', 'audience_id', 'id', null), ('public.photos', 'epoch', 'plaintext', null),
  ('public.photos', 'envelope', 'ciphertext', 'caption, tags and the keys to the image files'), ('public.photos', 'created_at', 'time', null),
  ('public.media_objects', 'path', 'id', 'random file name'), ('public.media_objects', 'owner_id', 'id', null), ('public.media_objects', 'post_id', 'id', null),
  ('public.media_objects', 'photo_id', 'id', null), ('public.media_objects', 'message_id', 'id', null), ('public.media_objects', 'story_id', 'id', null),
  ('public.media_objects', 'profile_avatar', 'plaintext', null), ('public.media_objects', 'bytes', 'plaintext', 'file size'), ('public.media_objects', 'created_at', 'time', null),
  ('public.tag_notices', 'photo_id', 'id', null), ('public.tag_notices', 'tagged_id', 'id', null), ('public.tag_notices', 'tagger_id', 'id', null),
  ('public.tag_notices', 'status', 'plaintext', null), ('public.tag_notices', 'created_at', 'time', null),

  ('public.friendships', 'user_a', 'id', null), ('public.friendships', 'user_b', 'id', null), ('public.friendships', 'status', 'plaintext', null),
  ('public.friendships', 'requested_by', 'id', null), ('public.friendships', 'note', 'ciphertext', 'the note sent with a request'),
  ('public.friendships', 'created_at', 'time', null), ('public.friendships', 'accepted_at', 'time', null),
  ('public.blocks', 'blocker', 'id', null), ('public.blocks', 'blocked', 'id', null), ('public.blocks', 'created_at', 'time', null),
  ('public.audiences', 'id', 'id', null), ('public.audiences', 'owner_id', 'id', null), ('public.audiences', 'kind', 'plaintext', null),
  ('public.audiences', 'current_epoch', 'plaintext', null), ('public.audiences', 'name_enc', 'ciphertext', 'chat or list name'), ('public.audiences', 'created_at', 'time', null),
  ('public.audience_members', 'audience_id', 'id', null), ('public.audience_members', 'member_id', 'id', null), ('public.audience_members', 'role', 'plaintext', null),
  ('public.audience_members', 'status', 'plaintext', null), ('public.audience_members', 'rsvp', 'plaintext', 'event answer'), ('public.audience_members', 'invited_by', 'id', null),
  ('public.audience_members', 'last_read_at', 'time', null), ('public.audience_members', 'created_at', 'time', null),
  ('public.audience_keys', 'audience_id', 'id', null), ('public.audience_keys', 'epoch', 'plaintext', null), ('public.audience_keys', 'recipient_id', 'id', null),
  ('public.audience_keys', 'sealed_by', 'id', null), ('public.audience_keys', 'sealed', 'ciphertext', 'a content key sealed to one person'), ('public.audience_keys', 'created_at', 'time', null),
  ('public.groups', 'id', 'id', null), ('public.groups', 'creator_id', 'id', null), ('public.groups', 'audience_id', 'id', null), ('public.groups', 'privacy', 'plaintext', null),
  ('public.groups', 'name_public', 'plaintext', 'only for open v1 groups'), ('public.groups', 'envelope', 'ciphertext', 'circle name, description and look'),
  ('public.groups', 'created_at', 'time', null), ('public.groups', 'envelope_by', 'id', null), ('public.groups', 'envelope_epoch', 'plaintext', null),
  ('public.events', 'id', 'id', null), ('public.events', 'host_id', 'id', null), ('public.events', 'audience_id', 'id', null), ('public.events', 'is_public', 'plaintext', null),
  ('public.events', 'public_body', 'plaintext', 'only for public events'), ('public.events', 'envelope', 'ciphertext', 'title, time, place and details'),
  ('public.events', 'created_at', 'time', null), ('public.events', 'envelope_by', 'id', null), ('public.events', 'envelope_epoch', 'plaintext', null), ('public.events', 'group_id', 'id', null),
  ('public.invites', 'code', 'hashed', 'random code'), ('public.invites', 'inviter_id', 'id', null), ('public.invites', 'max_uses', 'plaintext', null),
  ('public.invites', 'uses', 'plaintext', null), ('public.invites', 'expires_at', 'time', null), ('public.invites', 'created_at', 'time', null),

  ('public.conversations', 'id', 'id', null), ('public.conversations', 'audience_id', 'id', null), ('public.conversations', 'created_by', 'id', null),
  ('public.conversations', 'dm_key', 'id', 'the two people in a 1:1 chat'), ('public.conversations', 'last_message_at', 'time', null),
  ('public.conversations', 'created_at', 'time', null), ('public.conversations', 'rekey_needed', 'plaintext', null),
  ('public.messages', 'id', 'id', null), ('public.messages', 'conversation_id', 'id', null), ('public.messages', 'sender_id', 'id', null),
  ('public.messages', 'epoch', 'plaintext', null), ('public.messages', 'envelope', 'ciphertext', 'the message and attachments'), ('public.messages', 'created_at', 'time', null),
  ('public.message_reactions', 'message_id', 'id', null), ('public.message_reactions', 'user_id', 'id', null), ('public.message_reactions', 'conversation_id', 'id', null),
  ('public.message_reactions', 'epoch', 'plaintext', null), ('public.message_reactions', 'enc', 'ciphertext', 'which emoji'),
  ('public.message_reactions', 'created_at', 'time', null), ('public.message_reactions', 'updated_at', 'time', null),
  ('public.conversation_reads', 'conversation_id', 'id', null), ('public.conversation_reads', 'user_id', 'id', null), ('public.conversation_reads', 'last_read_at', 'time', null),

  ('public.notifications', 'id', 'id', null), ('public.notifications', 'recipient_id', 'id', null), ('public.notifications', 'actor_id', 'id', null),
  ('public.notifications', 'type', 'plaintext', null), ('public.notifications', 'object_kind', 'plaintext', null), ('public.notifications', 'object_id', 'id', null),
  ('public.notifications', 'sealed', 'ciphertext', 'the preview text'), ('public.notifications', 'created_at', 'time', null), ('public.notifications', 'read_at', 'time', null),
  ('public.reports', 'id', 'id', null), ('public.reports', 'reporter_id', 'id', null), ('public.reports', 'target_kind', 'plaintext', null), ('public.reports', 'target_id', 'id', null),
  ('public.reports', 'target_owner_id', 'id', null), ('public.reports', 'reason', 'plaintext', null), ('public.reports', 'details', 'plaintext', 'what the reporter wrote'),
  ('public.reports', 'disclosed', 'plaintext', 'content the reporter chose to show moderators'), ('public.reports', 'stored_envelope', 'ciphertext', null),
  ('public.reports', 'status', 'plaintext', null), ('public.reports', 'moderator_id', 'id', null), ('public.reports', 'decision_note', 'plaintext', null),
  ('public.reports', 'created_at', 'time', null), ('public.reports', 'resolved_at', 'time', null), ('public.reports', 'stored_meta', 'plaintext', null),
  ('public.moderation_actions', 'id', 'id', null), ('public.moderation_actions', 'moderator_id', 'id', null), ('public.moderation_actions', 'target_user_id', 'id', null),
  ('public.moderation_actions', 'report_id', 'id', null), ('public.moderation_actions', 'action', 'plaintext', null), ('public.moderation_actions', 'reason', 'plaintext', null),
  ('public.moderation_actions', 'expires_at', 'time', null), ('public.moderation_actions', 'created_at', 'time', null),
  ('public.recovery_requests', 'id', 'id', null), ('public.recovery_requests', 'owner_id', 'id', null), ('public.recovery_requests', 'eph_pub', 'plaintext', 'one-time public key'),
  ('public.recovery_requests', 'status', 'plaintext', null), ('public.recovery_requests', 'not_before', 'time', null), ('public.recovery_requests', 'expires_at', 'time', null),
  ('public.recovery_requests', 'created_at', 'time', null),
  ('public.recovery_responses', 'request_id', 'id', null), ('public.recovery_responses', 'trustee_id', 'id', null),
  ('public.recovery_responses', 'sealed', 'ciphertext', 'a recovery key piece sealed to the requester'), ('public.recovery_responses', 'created_at', 'time', null),

  ('public.key_challenges', 'id', 'id', null), ('public.key_challenges', 'user_id', 'id', null), ('public.key_challenges', 'nonce', 'hashed', 'random'),
  ('public.key_challenges', 'purpose', 'plaintext', null), ('public.key_challenges', 'created_at', 'time', null), ('public.key_challenges', 'used_at', 'time', null),
  ('public.webauthn_challenges', 'id', 'id', null), ('public.webauthn_challenges', 'intent', 'plaintext', null), ('public.webauthn_challenges', 'challenge', 'hashed', 'random'),
  ('public.webauthn_challenges', 'user_id', 'id', null), ('public.webauthn_challenges', 'new_user_id', 'id', null), ('public.webauthn_challenges', 'handle', 'plaintext', null),
  ('public.webauthn_challenges', 'webauthn_user_id', 'hashed', 'random'), ('public.webauthn_challenges', 'ip_tag', 'hashed', 'daily-rotating keyed hash of the IP address'),
  ('public.webauthn_challenges', 'created_at', 'time', null), ('public.webauthn_challenges', 'expires_at', 'time', null), ('public.webauthn_challenges', 'used_at', 'time', null),
  ('public.notice_email_verifications', 'token_hash', 'hashed', null), ('public.notice_email_verifications', 'user_id', 'id', null),
  ('public.notice_email_verifications', 'email', 'plaintext', null), ('public.notice_email_verifications', 'created_at', 'time', null),
  ('public.notice_email_verifications', 'expires_at', 'time', null), ('public.notice_email_verifications', 'used_at', 'time', null),
  ('public.notice_emails', 'kind', 'plaintext', null), ('public.notice_emails', 'ref_id', 'id', null), ('public.notice_emails', 'user_id', 'id', null), ('public.notice_emails', 'sent_at', 'time', null),
  ('public.account_deletion_requests', 'user_id', 'id', null), ('public.account_deletion_requests', 'requested_at', 'time', null),
  ('public.account_deletion_requests', 'execute_after', 'time', null),
  ('kw.rate_events', 'user_id', 'id', null), ('kw.rate_events', 'action', 'plaintext', null), ('kw.rate_events', 'at', 'time', null), ('kw.rate_events', 'id', 'id', null),

  ('public.pokes', 'from_id', 'id', null), ('public.pokes', 'to_id', 'id', null), ('public.pokes', 'created_at', 'time', null),
  ('public.pages', 'id', 'id', null), ('public.pages', 'owner_id', 'id', null), ('public.pages', 'name', 'plaintext', 'public'), ('public.pages', 'category', 'plaintext', 'public'),
  ('public.pages', 'about', 'plaintext', 'public'), ('public.pages', 'created_at', 'time', null),
  ('public.page_likes', 'page_id', 'id', null), ('public.page_likes', 'user_id', 'id', null), ('public.page_likes', 'created_at', 'time', null),
  ('public.poll_votes', 'post_id', 'id', null), ('public.poll_votes', 'voter_id', 'id', null), ('public.poll_votes', 'envelope', 'ciphertext', 'how you voted'), ('public.poll_votes', 'created_at', 'time', null),
  ('public.game_state', 'user_id', 'id', null), ('public.game_state', 'blob', 'ciphertext', null), ('public.game_state', 'version', 'plaintext', null), ('public.game_state', 'updated_at', 'time', null),
  ('public.game_actions', 'id', 'id', null), ('public.game_actions', 'from_id', 'id', null), ('public.game_actions', 'to_id', 'id', null), ('public.game_actions', 'kind', 'plaintext', null),
  ('public.game_actions', 'sealed', 'ciphertext', null), ('public.game_actions', 'created_at', 'time', null), ('public.game_actions', 'claimed_at', 'time', null),

  ('public.app_settings', 'key', 'plaintext', null), ('public.app_settings', 'value', 'plaintext', null), ('public.app_settings', 'updated_by', 'id', null), ('public.app_settings', 'updated_at', 'time', null),
  ('public.altcha_spent', 'signature', 'hashed', null), ('public.altcha_spent', 'spent_at', 'time', null),
  ('kw.push_config', 'id', 'id', null), ('kw.push_config', 'dispatch_url', 'plaintext', null), ('kw.push_config', 'secret', 'hashed', 'service secret'), ('kw.push_config', 'updated_at', 'time', null),
  ('kw.data_map_tables', 'table_name', 'plaintext', null), ('kw.data_map_tables', 'category', 'plaintext', null), ('kw.data_map_tables', 'owner_pred', 'plaintext', null),
  ('kw.data_map_tables', 'time_col', 'plaintext', null), ('kw.data_map_tables', 'size_col', 'plaintext', null), ('kw.data_map_tables', 'retention', 'plaintext', null),
  ('kw.data_map_tables', 'note', 'plaintext', null),
  ('kw.data_map_columns', 'table_name', 'plaintext', null), ('kw.data_map_columns', 'column_name', 'plaintext', null), ('kw.data_map_columns', 'class', 'plaintext', null),
  ('kw.data_map_columns', 'note', 'plaintext', null);

-- ---------------------------------------------------------------------------------------------
-- Phase 3 work streams that landed alongside this one (disappearing/scheduled/edit/unsend in
-- 20261024000100_ephemeral.sql, safety check-ins in 20261024000500_safety_checkins.sql). Inserted only
-- where the table/column exists, so this migration doesn't depend on their final shape; anything they
-- add or rename later must be classified by their own migration (the pgTAP check names any gap).
-- ---------------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note)
select v.* from (values
  ('public.safety_checkins', 'account', 't.owner_id = $1', 'created_at', null::text, 'Until you check in, cancel it, or a week after the alert is sent', 'That a check-in exists and its deadline; never the alert text.'),
  ('public.safety_checkin_alerts', 'account', 't.owner_id = $1', 'created_at', null::text, 'Until you check in or cancel it', 'Alerts sealed on your device, waiting for the deadline.'),
  ('kw.media_trash', 'system', null, null, null::text, 'Paths of deleted files, until the files are removed', null)
) v(table_name, category, owner_pred, time_col, size_col, retention, note)
where to_regclass(v.table_name) is not null;

insert into kw.data_map_columns (table_name, column_name, class, note)
select v.* from (values
  ('public.posts', 'publish_at', 'time', 'scheduled time'), ('public.posts', 'disappear_secs', 'plaintext', 'disappearing timer'),
  ('public.posts', 'expires_at', 'time', null), ('public.comments', 'edited_at', 'time', null),
  ('public.messages', 'expires_at', 'time', null), ('public.messages', 'edited_at', 'time', null), ('public.messages', 'unsent_at', 'time', null),
  ('public.messages', 'notice', 'plaintext', 'server notices such as "messages now disappear after 4 weeks"'),
  ('public.conversations', 'disappear_secs', 'plaintext', 'disappearing timer'), ('public.conversations', 'disappear_set_at', 'time', null),
  ('public.safety_checkins', 'id', 'id', null), ('public.safety_checkins', 'owner_id', 'id', null), ('public.safety_checkins', 'due_at', 'time', 'deadline'),
  ('public.safety_checkins', 'repeat_daily', 'plaintext', null), ('public.safety_checkins', 'released_at', 'time', null), ('public.safety_checkins', 'created_at', 'time', null),
  ('public.safety_checkin_alerts', 'id', 'id', null), ('public.safety_checkin_alerts', 'checkin_id', 'id', null), ('public.safety_checkin_alerts', 'owner_id', 'id', null),
  ('public.safety_checkin_alerts', 'conversation_id', 'id', 'which chat would be alerted'), ('public.safety_checkin_alerts', 'epoch', 'plaintext', null),
  ('public.safety_checkin_alerts', 'envelope', 'ciphertext', 'the alert message'), ('public.safety_checkin_alerts', 'created_at', 'time', null),
  ('kw.media_trash', 'path', 'id', 'random file name'), ('kw.media_trash', 'trashed_at', 'time', null)
) v(table_name, column_name, class, note)
where exists (select 1 from information_schema.columns c
               where c.table_schema = split_part(v.table_name, '.', 1) and c.table_name = split_part(v.table_name, '.', 2)
                 and c.column_name = v.column_name)
  and exists (select 1 from kw.data_map_tables m where m.table_name = v.table_name);

-- ---------------------------------------------------------------------------------------------
-- Found while building the map: kw.rate_events (spam-limit counters) had no link to the account, so its
-- rows survived account deletion, and nothing ever removed old ones. Delete orphans, cascade from now
-- on, and keep only a week (the longest rate-limit window is one day; keep this ≥ that window).
-- ---------------------------------------------------------------------------------------------
delete from kw.rate_events r where not exists (select 1 from auth.users u where u.id = r.user_id);
alter table kw.rate_events
  add constraint rate_events_user_fk foreign key (user_id) references auth.users (id) on delete cascade;

create function kw.transparency_maintenance() returns void
language sql security definer set search_path = '' as $$
  delete from kw.rate_events where at < now() - interval '7 days';
$$;
revoke execute on function kw.transparency_maintenance() from public, anon, authenticated;
select cron.schedule('kithwall-transparency-maintenance', '41 * * * *', $$select kw.transparency_maintenance()$$);

-- ---------------------------------------------------------------------------------------------
-- The report
-- ---------------------------------------------------------------------------------------------
create function public.transparency_report() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  u record;
  tbl record;
  n bigint;
  first_at timestamptz;
  last_at timestamptz;
  total numeric;
  sch text;
  rel text;
  tables jsonb := '[]'::jsonb;
  acct jsonb;
  passkeys jsonb;
  sessions jsonb;
  factors int;
  audit jsonb;
  files jsonb;
  sec record;
  prof record;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;

  select au.created_at, au.last_sign_in_at, au.email, au.email_confirmed_at, au.updated_at
    into u from auth.users au where au.id = uid;
  select p.username, p.created_at, p.discoverable, p.display_name_public, p.key_version, p.status, p.suspended_until
    into prof from public.profiles p where p.id = uid;
  select s.recovery_saved_at, s.notice_email, s.notice_email_verified_at into sec
    from public.account_security s where s.user_id = uid;
  select count(*) into factors from auth.mfa_factors f where f.user_id = uid and f.status = 'verified';

  acct := jsonb_build_object(
    'user_id', uid,
    'handle', prof.username,
    'created_at', coalesce(prof.created_at, u.created_at),
    'auth_created_at', u.created_at,
    'last_sign_in_at', u.last_sign_in_at,
    -- Passkey and passphrase accounts get a made-up, non-routable address (docs/v2/01-accounts.md §2).
    'email_kind', case when u.email is null or u.email = '' then 'none'
                       when lower(u.email) like '%@id.kithwall.invalid' then 'synthetic' else 'real' end,
    'email', case when u.email is null or lower(u.email) like '%@id.kithwall.invalid' then null else u.email end,
    'synthetic_email', case when lower(u.email) like '%@id.kithwall.invalid' then u.email end,
    'email_confirmed_at', case when lower(u.email) like '%@id.kithwall.invalid' then null else u.email_confirmed_at end,
    'notice_email', sec.notice_email,
    'notice_email_verified_at', sec.notice_email_verified_at,
    'recovery_saved_at', sec.recovery_saved_at,
    'mfa_factors', factors,
    'discoverable', prof.discoverable,
    'directory_name', prof.display_name_public,
    'key_version', prof.key_version,
    'status', prof.status,
    'suspended_until', prof.suspended_until
  );

  select coalesce(jsonb_agg(jsonb_build_object(
           'label', k.label, 'created_at', k.created_at, 'last_used_at', k.last_used_at,
           'backed_up', k.backed_up, 'transports', to_jsonb(k.transports)) order by k.created_at), '[]'::jsonb)
    into passkeys from public.passkeys k where k.user_id = uid;

  -- Sign-in sessions kept by the auth server (Supabase Auth): it records the browser and IP address.
  select coalesce(jsonb_agg(jsonb_build_object(
           'created_at', s.created_at, 'refreshed_at', coalesce(s.refreshed_at::timestamptz, s.updated_at),
           'user_agent', s.user_agent, 'ip', host(s.ip), 'aal', s.aal::text) order by s.created_at desc), '[]'::jsonb)
    into sessions from auth.sessions s where s.user_id = uid;

  select jsonb_build_object('count', count(*), 'first', min(a.created_at), 'last', max(a.created_at))
    into audit from auth.audit_log_entries a where a.payload ->> 'actor_id' = uid::text;

  select jsonb_build_object('count', count(*), 'bytes', coalesce(sum((o.metadata ->> 'size')::bigint), 0),
                            'first', min(o.created_at), 'last', max(o.created_at))
    into files from storage.objects o where o.bucket_id = 'media' and (o.owner_id = uid::text or o.name like uid::text || '/%');

  for tbl in
    select m.table_name, m.category, m.owner_pred, m.time_col, m.size_col, m.retention, m.note
      from kw.data_map_tables m where m.owner_pred is not null order by m.category, m.table_name
  loop
    sch := split_part(tbl.table_name, '.', 1);
    rel := split_part(tbl.table_name, '.', 2);
    first_at := null; last_at := null; total := null;
    execute format('select count(*), %s, %s, %s from %I.%I t where %s',
        case when tbl.time_col is null then 'null::timestamptz' else format('min(t.%I)', tbl.time_col) end,
        case when tbl.time_col is null then 'null::timestamptz' else format('max(t.%I)', tbl.time_col) end,
        case when tbl.size_col is null then 'null::numeric' else format('sum(t.%I)', tbl.size_col) end,
        sch, rel, tbl.owner_pred)
      into n, first_at, last_at, total using uid;
    tables := tables || jsonb_build_object(
      'table', tbl.table_name, 'category', tbl.category, 'rows', n, 'first', first_at, 'last', last_at,
      'bytes', total, 'retention', tbl.retention, 'note', tbl.note,
      'columns', (select jsonb_object_agg(c.class, c.cols) from (
          select dc.class, jsonb_agg(dc.column_name order by dc.column_name) as cols
            from kw.data_map_columns dc where dc.table_name = tbl.table_name group by dc.class) c));
  end loop;

  return jsonb_build_object(
    'version', 1,
    'generated_at', now(),
    'account', acct,
    'passkeys', passkeys,
    'sessions', sessions,
    'auth_log', audit,
    'files', files,
    'tables', tables
  );
end $$;

revoke execute on function public.transparency_report() from public, anon;
grant execute on function public.transparency_report() to authenticated;

-- The static data map (no rows, no counts) for the public /transparency page and for tests.
create function public.transparency_data_map() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object(
           'table', m.table_name, 'category', m.category, 'retention', m.retention, 'note', m.note,
           'columns', (select jsonb_object_agg(c.class, c.cols) from (
               select dc.class, jsonb_agg(dc.column_name order by dc.column_name) as cols
                 from kw.data_map_columns dc where dc.table_name = m.table_name group by dc.class) c))
           order by m.category, m.table_name)
    from kw.data_map_tables m where m.category <> 'system'
$$;
revoke execute on function public.transparency_data_map() from public;
grant execute on function public.transparency_data_map() to anon, authenticated;
