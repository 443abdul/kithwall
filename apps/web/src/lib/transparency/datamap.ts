// Plain-language labels for the server's data map (kw.data_map_tables / kw.data_map_columns in
// supabase/migrations/20261024000900_transparency.sql). The database map is the source of truth and is
// complete (pgTAP fails on any unclassified column); this file only adds readable words for the tables
// people care about. Tables without an entry here are still shown, by name, with their column classes.
import type { MessageKey } from '@/i18n';
import type { IconName } from '@/components/ui/Icon';

export type ColumnClass = 'id' | 'time' | 'plaintext' | 'ciphertext' | 'hashed';
export type DataCategory = 'account' | 'content' | 'social' | 'messages' | 'activity' | 'housekeeping' | 'system';

export const COLUMN_CLASSES: ColumnClass[] = ['ciphertext', 'plaintext', 'time', 'id', 'hashed'];

export const CATEGORIES: { id: Exclude<DataCategory, 'system'>; icon: IconName; title: MessageKey; body: MessageKey }[] = [
  { id: 'content', icon: 'edit', title: 'transparency.cat.content', body: 'transparency.cat.contentBody' },
  { id: 'messages', icon: 'messages', title: 'transparency.cat.messages', body: 'transparency.cat.messagesBody' },
  { id: 'social', icon: 'users', title: 'transparency.cat.social', body: 'transparency.cat.socialBody' },
  { id: 'account', icon: 'key', title: 'transparency.cat.account', body: 'transparency.cat.accountBody' },
  { id: 'activity', icon: 'activity', title: 'transparency.cat.activity', body: 'transparency.cat.activityBody' },
  { id: 'housekeeping', icon: 'clock', title: 'transparency.cat.housekeeping', body: 'transparency.cat.housekeepingBody' },
];

export interface TableInfo {
  label: MessageKey;
  /** What the server can see (readable metadata). */
  sees: MessageKey;
  /** What it can't (encrypted); omitted when nothing in the table is encrypted. */
  hidden?: MessageKey;
}

export const TABLES: Record<string, TableInfo> = {
  'public.posts': { label: 'transparency.t.posts.label', sees: 'transparency.t.posts.sees', hidden: 'transparency.t.posts.hidden' },
  'public.comments': { label: 'transparency.t.comments.label', sees: 'transparency.t.comments.sees', hidden: 'transparency.t.comments.hidden' },
  'public.likes': { label: 'transparency.t.likes.label', sees: 'transparency.t.likes.sees' },
  'public.stories': { label: 'transparency.t.stories.label', sees: 'transparency.t.stories.sees', hidden: 'transparency.t.stories.hidden' },
  'public.story_views': { label: 'transparency.t.storyViews.label', sees: 'transparency.t.storyViews.sees' },
  'public.albums': { label: 'transparency.t.albums.label', sees: 'transparency.t.albums.sees', hidden: 'transparency.t.albums.hidden' },
  'public.photos': { label: 'transparency.t.photos.label', sees: 'transparency.t.photos.sees', hidden: 'transparency.t.photos.hidden' },
  'public.media_objects': { label: 'transparency.t.files.label', sees: 'transparency.t.files.sees', hidden: 'transparency.t.files.hidden' },
  'public.conversations': { label: 'transparency.t.conversations.label', sees: 'transparency.t.conversations.sees', hidden: 'transparency.t.conversations.hidden' },
  'public.messages': { label: 'transparency.t.messages.label', sees: 'transparency.t.messages.sees', hidden: 'transparency.t.messages.hidden' },
  'public.message_reactions': { label: 'transparency.t.reactions.label', sees: 'transparency.t.reactions.sees', hidden: 'transparency.t.reactions.hidden' },
  'public.friendships': { label: 'transparency.t.friendships.label', sees: 'transparency.t.friendships.sees', hidden: 'transparency.t.friendships.hidden' },
  'public.blocks': { label: 'transparency.t.blocks.label', sees: 'transparency.t.blocks.sees' },
  'public.audiences': { label: 'transparency.t.audiences.label', sees: 'transparency.t.audiences.sees', hidden: 'transparency.t.audiences.hidden' },
  'public.audience_members': { label: 'transparency.t.memberships.label', sees: 'transparency.t.memberships.sees' },
  'public.audience_keys': { label: 'transparency.t.audienceKeys.label', sees: 'transparency.t.audienceKeys.sees', hidden: 'transparency.t.audienceKeys.hidden' },
  'public.groups': { label: 'transparency.t.groups.label', sees: 'transparency.t.groups.sees', hidden: 'transparency.t.groups.hidden' },
  'public.events': { label: 'transparency.t.events.label', sees: 'transparency.t.events.sees', hidden: 'transparency.t.events.hidden' },
  'public.profiles': { label: 'transparency.t.profiles.label', sees: 'transparency.t.profiles.sees', hidden: 'transparency.t.profiles.hidden' },
  'public.profile_info': { label: 'transparency.t.profileInfo.label', sees: 'transparency.t.profileInfo.sees', hidden: 'transparency.t.profileInfo.hidden' },
  'public.key_bundles': { label: 'transparency.t.keyBundles.label', sees: 'transparency.t.keyBundles.sees', hidden: 'transparency.t.keyBundles.hidden' },
  'public.passkeys': { label: 'transparency.t.passkeys.label', sees: 'transparency.t.passkeys.sees', hidden: 'transparency.t.passkeys.hidden' },
  'public.vault': { label: 'transparency.t.vault.label', sees: 'transparency.t.vault.sees', hidden: 'transparency.t.vault.hidden' },
  'public.push_subscriptions': { label: 'transparency.t.push.label', sees: 'transparency.t.push.sees', hidden: 'transparency.t.push.hidden' },
  'public.native_push_devices': { label: 'transparency.t.nativePush.label', sees: 'transparency.t.nativePush.sees', hidden: 'transparency.t.nativePush.hidden' },
  'public.safety_checkins': { label: 'transparency.t.checkins.label', sees: 'transparency.t.checkins.sees', hidden: 'transparency.t.checkins.hidden' },
  'public.notifications': { label: 'transparency.t.notifications.label', sees: 'transparency.t.notifications.sees', hidden: 'transparency.t.notifications.hidden' },
  'public.reports': { label: 'transparency.t.reports.label', sees: 'transparency.t.reports.sees' },
  'kw.rate_events': { label: 'transparency.t.rateEvents.label', sees: 'transparency.t.rateEvents.sees', hidden: 'transparency.t.rateEvents.hidden' },
};

/** Which category each curated table belongs to (mirrors the database map, for the static page). */
export const STATIC_MAP: { category: Exclude<DataCategory, 'system' | 'housekeeping'>; tables: string[] }[] = [
  { category: 'content', tables: ['public.posts', 'public.comments', 'public.likes', 'public.stories', 'public.story_views', 'public.albums', 'public.photos', 'public.media_objects'] },
  { category: 'messages', tables: ['public.conversations', 'public.messages', 'public.message_reactions'] },
  { category: 'social', tables: ['public.friendships', 'public.blocks', 'public.audiences', 'public.audience_members', 'public.audience_keys', 'public.groups', 'public.events'] },
  { category: 'account', tables: ['public.profiles', 'public.profile_info', 'public.key_bundles', 'public.passkeys', 'public.vault', 'public.push_subscriptions', 'public.native_push_devices', 'public.safety_checkins'] },
  { category: 'activity', tables: ['public.notifications', 'public.reports'] },
];

/** "public.audience_members" → "audience members" (for tables without a label). */
export function tableName(table: string): string {
  return (table.split('.')[1] ?? table).replace(/_/g, ' ');
}
