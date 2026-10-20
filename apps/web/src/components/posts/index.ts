// Kithwall 2 post components: the CONTRACT shared by every screen that shows posts
// (Home, profiles, Circles, events). Owned and implemented by the feed & people work stream;
// other streams import only from here.
export type FeedScope =
  | { kind: 'home' }                          // connections + circles, chronological
  | { kind: 'profile'; userId: string }        // posts on/by a person
  | { kind: 'circle'; circleId: string }       // a circle's feed (v1 group_id)
  | { kind: 'event'; eventId: string };        // an event's discussion

export type ComposerAudience =
  | { kind: 'connections' }                    // everyone you're connected with
  | { kind: 'circle'; circleId: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'only_me' };

export interface FeedProps {
  scope: FeedScope;
  /** Rendered when there are no posts (defaults to a generic empty state). */
  empty?: React.ReactNode;
}

export interface ComposerProps {
  /** Pre-selected audience; for circle/event scopes the audience is fixed. */
  audience: ComposerAudience;
  /** Lock the audience picker (e.g. inside a circle). */
  fixedAudience?: boolean;
  placeholder?: string;
  onPosted?: () => void;
}

export { Feed } from './Feed';
export { Composer } from './Composer';
