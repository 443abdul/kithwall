-- Kithwall 2: preview pictures on the automated accounts' posts (docs/v2/13-official-accounts.md §2).
--
-- A link or video post of an automated account went out as text and a bare card: no picture on the card, a
-- grey box where a video's thumbnail belongs. Explore looked broken. The job now gives each such post the
-- picture a person's post of the same link gets (the one the publisher names for link previews; a video's
-- thumbnail), fetched by the server, encrypted and stored like every picture.
--
-- Fetching it can fail (the publisher's site is slow that minute), and the posts made so far have none. So the
-- job remembers, per posted item, whether the post has its picture and how often it tried, and later runs go
-- back and add it: the account edits its own post, as a person would.

alter table public.official_items
  add column has_picture boolean not null default false,
  add column picture_tries smallint not null default 0 check (picture_tries between 0 and 100);

-- Posts that already carry a picture (NASA's image of the day, Commons' picture of the day).
update public.official_items i set has_picture = true
 where exists (select 1 from public.media_objects m where m.post_id = i.post_id);

insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.official_items', 'has_picture', 'plaintext', 'whether the post made from it has its preview picture'),
  ('public.official_items', 'picture_tries', 'plaintext', 'how often the job tried to fetch that picture');
