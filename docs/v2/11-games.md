# Kithwall 2: games inside chats

Status: implemented · 2026-11-11 · `roadmap-2026-11.md`, round 4

People can play board games with each other inside any chat, one-to-one or group. A game is made of
ordinary end-to-end encrypted chat messages: an invitation, then one message per move. Nothing about games
exists on the server: no table, no column, no RPC, no setting. The server sees more small encrypted
messages in a chat and nothing else; it can't tell a move from "ok".

Because moves are messages, a game can be played at the players' own pace (move now, answer tomorrow),
survives bad connections (a move made offline waits in the chat's send queue), follows the chat's
disappearing-message timer, is covered by franking, and behaves in hidden chats and for blocked people
exactly like any other message. Players may also put a clock on a game.

**Games:** tic-tac-toe, chess (full rules), checkers (English draughts), Connect Four, Reversi, Ludo (2–4
players, fair dice), Five in a Row (Gomoku), Dots and Boxes, Mancala (Kalah). Battleship is not included
(§9).

Code: `packages/crypto/src/games.ts` (chain hash, dice), `apps/web/src/lib/games/` (one pure engine per
game, `match.ts` the protocol, `thread.ts` messages → games, `play.ts` secrets and server time),
`apps/web/src/components/games/` (boards, card, game screen, picker, games list),
`components/messages/ChatThread.tsx` (card in the thread, sending), `ChatComposer.tsx` (plus menu),
`ChatInfo.tsx` (Games), `ChatList.tsx` (preview), `styles/v2/games.css`.

## 1. What people see

- **Starting.** The composer's plus button opens a menu: photos and videos, or **Play a game**. Pick a
  game, who plays (the other person in a one-to-one chat; chosen members in a group: one opponent, or up
  to three for Ludo), who goes first (random, me, them) and a clock (none by default). This sends an
  invitation. The game starts when everyone invited has accepted; anyone invited can decline (a game for
  two is then off; Ludo goes ahead with those left if at least two remain); the inviter can withdraw it.
- **One card per game.** The conversation shows a single card for a game, standing where the game's newest
  message is: a small picture of the board, who is playing, whose turn it is or how it ended. It changes
  in place as moves arrive; there is no bubble per move. An invitation can be accepted or declined on the
  card. Tapping the card opens the full board.
- **The game screen.** Board, whose turn, clocks, the die (Ludo), draw offers, resign, "Claim win on time",
  rematch, the move list in algebraic notation (chess) and "How to play", which states the rule set.
  Members who aren't playing see the same screen without the controls and can watch live.
- **Conversation list.** The preview of a chat whose newest message belongs to a game says where the game
  stands: "Chess: your move", "Ludo: Ann's turn", "Reversi: you won".
- **Games on the chat's info screen.** Games going on, finished games, and the score (won / drawn / lost per
  person), all worked out on the device from the messages still in the chat.
- **Accessibility.** Every square is a button with a spoken name ("e4: white knight, you can move here").
  Arrow keys move between squares, Enter or Space taps, one square is in the tab order. Status changes are
  announced (`aria-live`). Boards work with touch, mouse and keyboard, at 320 px width and in the Android
  app's WebView; pieces are inline SVG drawn for Kithwall (no images, fonts or downloads, so Data Saver has
  nothing to block). Sides differ by shape as well as colour. Boards are not mirrored in right-to-left
  languages (a chess board has one orientation); the screen around them is. The only motion (the die, the
  pulse on a movable Ludo piece) is off with reduced motion.

## 2. Message format

A game message is a chat message whose payload is `{ text: "", game: GameEvent }` (`ChatPayload.game`,
`lib/messages.ts`). It is sealed, signed, padded and franked like every other message; the franking
commitment covers the whole payload, so a reported game message carries proof of its sender like any
other.

```
GameEvent = { v: 1, g, n, p, r, a, s }

g   the game: the id of its invitation message (a UUID chosen by the inviter's device)
n   number of this message in the game (0 = the invitation)
p   chain: base64url SHA-256("kithwall/v1/game-link\n" ‖ canonicalJson(previous GameEvent)); "" for n = 0
r   a fresh public nonce, 16 random bytes
a   the action:  {t:"invite"} {t:"accept", c?} {t:"decline"} {t:"cancel"}
                 {t:"move", m, x?, c?} {t:"resign"} {t:"offer"} {t:"agree"} {t:"refuse"} {t:"claim"}
s   the match after this message (below)
```

`m` is the move in the engine's own shape (chess `{f, t, p?}`, checkers `{p: [from, …landing]}`, Ludo
`{k}` …). `x` and `c` are the dice reveal and commitment (§5).

```
Match = { kind, players, by, clock, status, ok, state, result, offer, time, dice, left, from, t0, moves, who }

players  user ids in seat order (seat 0 moves first)        by      who invited
clock    null | {k:"total"|"move", ms}                       status  invited | active | over | cancelled
ok       who has accepted                                    state   the engine's state (plain JSON)
result   null | {winner: seat|null, why}                     offer   seat with a draw offer open, or null
time     {left[], base, tick}  (§6)                          dice    null | {c[], cn[], seed, k, e, en}  (§5)
left     seats that left a game for more than two            from    game this is a rematch of, or null
t0       server time of the invitation                       who     seat that sent this message
```

Server times inside a match (`t0`, `time.base`) are whole milliseconds since 1970, not the text the database
returned, so the same instant gives the same match on every device whatever the timestamp's formatting.

Every message carries the whole match so that a game can go on after its earlier messages have
disappeared (§7). A chess message is about 1–3 KB before padding; the message size limit (64 KB of
envelope) allows games of well over a thousand moves.

## 3. Validation: one rule book, run by every device

`step(previous match, context, action)` in `lib/games/match.ts` is the rule book. The context is who sent
the message (the envelope's signed author), the chain value and server time of the message before it, and
the server time of this message. It returns the next match or refuses. The game-specific part is the
engine (`lib/games/<game>.ts`): legal moves, applying a move, the result.

- The sender's device calls `nextEvent`, which runs `step` and writes the result into `s`.
- **Every** device (players' other devices, opponents, spectators) runs the same `step` on every game
  message it sees and requires that it follows the message it names in `p`, that the action is legal for
  that sender at that point, and that `s` equals, as canonical JSON, what `step` computed. Anything else is
  refused: it changes nothing in the game and the thread shows *"X sent a move that isn't allowed. It was
  ignored."* So a changed app can't play out of turn, make an illegal move, move twice, misreport a roll or
  a clock, or attach a wrong position to a legal move.
- Nothing in a message is trusted before `parseEvent` has checked its shape (every field, every board).

Who may do what: `accept` / `decline` an invited player who hasn't answered; `cancel` the inviter while
invited; `move` the seat whose turn it is; `resign` any player of a running game (the other player wins;
in a game for more than two that seat's pieces are taken off and play goes on); `offer` a player of a
two-player game without dice, one offer at a time; `agree` / `refuse` the other player (moving on also
refuses); `claim` any player other than the one to move, once that player's time is up (§6).

Game results come from the engine (`checkmate`, `stalemate`, `material`, `repetition`, `fifty`, `line`,
`full`, `count`, `blocked`, `quiet`, `home`) or from the match (`resign`, `time`, `agreed`, `left`,
`declined`, `cancelled`).

### Rule sets

- **Chess**: full legal move generation; check, checkmate, stalemate; castling on both sides with all
  conditions; en passant; promotion to a chosen piece; draws by threefold repetition, the fifty-move rule
  and insufficient material (bare kings, a single minor piece, bishops all on one colour); draw offers and
  resignation. Decision: repetition and the fifty-move rule end the game by themselves, so no judge or
  claim is needed. Move list in algebraic notation; the board is drawn from Black's side for Black; last
  move, legal moves and check are highlighted. No computer opponent.
- **Checkers**: English draughts (American checkers). Dark moves first; captures are forced and a
  multi-jump must be finished in the same turn, with a free choice between captures; a man that reaches
  the far row is crowned and the turn ends; kings move and jump one square in all four diagonals; the
  player with no legal move loses; 40 moves each without a capture or man move is a draw.
- **Ludo**: six to leave the yard, a six rolls again, three sixes in a row forfeit the turn, landing on a
  single piece of another player sends it home, start and star squares are safe, two pieces of one player
  on a square are safe, exact roll to get home, a piece must move if one can, first to bring all four home
  wins and the game ends. With two players the seats are opposite corners.
- **Reversi**: dark first, forced passes are automatic, most discs at the end wins.
- **Connect Four** 7 × 6; **tic-tac-toe**; **Five in a Row** 15 × 15, five or more wins (freestyle);
  **Dots and Boxes** 5 × 5 boxes, closing a box moves again; **Mancala**: Kalah, 6 pits × 4 seeds, extra
  move for the store, capture from an empty own pit when the opposite pit has seeds.

## 4. From messages to games: order, duplicates, devices, edits, deletions

`lib/games/thread.ts` (`buildGames`) turns the game messages of a chat into games. It is a pure function
of the messages, so every device that sees the same messages gets the same games.

1. Messages are sorted by the server's `created_at` (then id). Arrival order doesn't matter.
2. A message with `n = 0` is an invitation if it is well-formed, sent by its inviter, and carried by the
   chat message whose id is `g`. (So nobody can start a second "game `g`".)
3. A message that names an accepted message in `p`, with the next `n`, is checked with `step`. Accepted, it
   extends that chain. If that place in the chain was already taken by an earlier message, it is dropped
   **silently**: this is what happens to the same event sent twice, to a move from a second device of the
   same person, and to a move written offline that arrives after the other player resigned. A claim that
   came too early by the server's clock is ignored silently too.
4. A message that names nothing the device has becomes the start of a chain of its own, on trust for now
   (see §7), if its sender is the player it says it is.
5. Which chain is the game, if there are several: **the one that holds my own newest message**. My device
   only ever builds on moves it checked, so that chain is the game I played. For a game I'm not playing:
   the chain that starts at the invitation; failing that, the newest. Messages that started other chains
   after the game's first message are reported as not allowed.

Consequences, on purpose:

- **Two devices of the same person** both derive the game from the chat, so they agree. If both send a
  move for the same turn, the one the server stored first is the move.
- **Losing a race.** When a message of mine loses its place to someone else's (two people accept an
  invitation at the same moment; I move just as the other player offers a draw), the device that sent it
  sends it again on top of the winner, once, if it is still allowed there and nothing else has happened
  since (`ChatThread`, `GameView.dropped`). A reveal that lost a race is public, but the roll that follows
  mixes in the message that beat it, which was written before the reveal could be seen.
- **Editing a game message** is not offered, and `editMessage` refuses it. If a changed app edits one
  anyway, every device that loads it afterwards refuses it (the server marks edits with `edited_at`), so
  the edit can only undo the editor's own move, never change it.
- **Unsending a game message** is not offered either (the game card has no message menu). If a changed app
  unsends its newest move before anyone answered, the move simply never happened. **Once another move
  follows, a move can't be taken back:** the answer names the deleted move's hash, and the answering
  player's device keeps following the chain with its own answer in it (rule 5), which carries the whole
  position. The cheater's replacement move hangs on the old chain and is ignored by that device. The
  cheater can either go on from the real position or not play at all.
- **A made-up position** (a message that skips ahead) hangs on nothing the others have, isn't theirs, and
  is reported as not allowed.
- While some messages of a chat can't be decrypted yet (a key is still on its way), messages that seem to
  hang on nothing are not reported: their neighbours may just be unreadable for now.
- **The conversation-list preview is not checked.** The list only has a chat's newest message, so its
  preview ("Chess: your move") is read from that one message's own copy of the match. A refused message
  that happens to be the newest can therefore say something untrue in the list until the next message; the
  card and the game screen, which check the chain, are what counts.

**My move shows at once.** A move being sent is applied on top of the game on the sender's screen (the
card says "Sending…" or "Waiting for a connection") and goes through the chat's existing queue: offline,
it is kept and sent when the connection returns, with the same message id on every retry so it can't be
stored twice. One game message at a time per game per device: the next can only be written once the one
before has a server time (clocks depend on it).

## 5. Fair dice

Requirement: no single player and not the server may choose or predict a roll; every device must be able
to verify every roll; no waiting beyond normal turns.

Primitives (`packages/crypto/src/games.ts`, tested in `packages/crypto/test/games.test.ts`):

```
gameKey = HKDF-SHA-256(account master key, "kithwall/v1/games")           never leaves the device
secret  = HMAC-SHA-256(gameKey, "kithwall/v1/dice-secret\n" ‖ lp(g, u64(n)))      n = message number
commit  = SHA-256("kithwall/v1/dice-commit\n" ‖ lp(g, secret))
seed    = SHA-256("kithwall/v1/dice-seed\n" ‖ lp(g, secret, e))                    e = chain value, below
roll k  = uniform in 1..6 from SHA-256("kithwall/v1/dice-roll\n" ‖ lp(seed, u64(k), u64(block)))
          (bytes ≥ 252 are skipped, so there is no modulo bias)
```

Protocol, threaded through the messages a game has anyway:

1. **Commit.** The inviter's invitation carries their commitment; each `accept` carries the acceptor's.
   The inviter always takes seat 0 in a dice game (rolls first).
2. **Turn.** The first message of a player's turn reveals the secret behind their open commitment (`x`),
   and carries a fresh commitment (`c`) for their next turn. Every device checks that `x` opens the
   commitment.
3. **Mix.** The seed is the revealed secret hashed with `e`: the chain value (hash) of **the newest game
   message that the roller did not send**. That hash covers the whole game so far, including every other
   player's nonces and reveals. `step` also requires that this message is newer than the roller's
   commitment.
4. **Roll.** The turn's rolls are `roll 0`, and after a six `roll 1`, then `roll 2`, from the same seed.
   The move message says which piece moves; every device recomputes the roll and checks the move against
   it. A turn with no possible move is a "pass" message, which is still the reveal.

The secret is derived from the account's master key instead of being stored: any device of the same person
can open a commitment another of their devices made, nothing secret sits in storage between turns, and
nobody else can compute it (HMAC under a secret key is a PRF).

**Why this is fair.**

- *The roller can't choose.* The secret was fixed by the commitment (SHA-256 is binding) before the
  message `e` existed, and `e` contains at least one value the roller couldn't know then: another
  player's later nonce or reveal. Changing anything afterwards is impossible: a different secret doesn't
  open the commitment; `e` is someone else's message.
- *Nobody else can choose or predict.* The other players and the server see only the commitment, a hash of
  32 unpredictable bytes, until the reveal. The sender of `e` can vary their nonce, but without the secret
  every candidate seed is equally unknown to them.
- *The server can't choose or predict.* It never sees secrets, commitments, nonces or rolls (all inside
  encrypted messages). It can refuse or delay messages, as with any chat, but can't steer a roll: the roll
  doesn't depend on timestamps or order of arrival, only on the chain.
- *Everyone verifies.* Reveals are public inside the chat; `step` recomputes every roll on every device.
- *No extra waiting.* The roll needs nothing beyond the previous turn's message.

**Limits, stated plainly.**

- *The roller learns the roll first* (when the previous message arrives) and could then simply never
  reveal. That is the commit-reveal abort problem; the answer is the fallback below.
- *Bonus rolls are known to the roller when the turn starts.* After a six, the same player rolls again
  with nobody else's message in between, so a fresh contribution from another player would mean waiting
  for one. All rolls of a turn therefore come from the one seed: the roller can't choose them, but once the
  turn has started the seed (hence the possible second and third roll) is visible to everyone, the roller
  included, before the first move is chosen. This affects only the turn of a six.
- *Collusion.* If the roller and **every** player who sent a message between the roller's commitment and
  reveal work together, they can search nonces for a seed they like. With one honest player in between
  (always the case in a two-player game with an honest opponent) they can't.

**Fallback when a player disappears.** A turn needs its player's reveal, so a player who stops would
freeze the game. If the game has a clock per move, anyone else may `claim` when the time is up: in a game
of two the claimant wins; with more players the absent one is taken out (their pieces come off, their
commitment is dropped) and play goes on with the next player, whose rolls mix in the claim message. Games
for more than two **without** a clock have a built-in limit of 24 hours per turn for the same purpose
(`IDLE_DROP_MS`). A two-player game without a clock has no limit, like any correspondence game: the other
player can wait, or resign and start again.

## 6. Clocks

Optional per game: none (default), 1, 5 or 10 minutes each for the whole game (two players), or 1 day per
move. The protocol accepts any limit from 10 seconds to 7 days.

- **Time is the server's.** A turn lasts from the `created_at` of the message that started it to the
  `created_at` of the move that ends it. Both are set by the database on insert (`kw.messages_guard`
  overwrites any client value). Device clocks are never used for the result.
- The match stores `time = {left, base, tick}`: time left per seat as of `base` (the server time the
  running turn started), and `tick`, the seat whose time ran until the message carrying it. A message
  can't contain its own server time, so the device applying the *next* message settles it (`settle`). The
  clock starts when the last invited player accepts.
- **Out of time.** Nothing happens by itself. The other player (any other player in a group game) sends
  `claim`. Every device checks it against the server's times: the claim's own `created_at` minus `base`
  must be at least the time the player to move had left. A claim that the server stored too early is
  ignored (not an offence). A move that arrives after the time was up but before anyone claimed is still
  a move (as over the board: the flag has to be called), with the clock then at zero.
- **Showing a countdown** needs the server's time *now*. Every stored message the device sees says "the
  server's clock had reached at least this"; the largest such difference to the device's own clock is the
  estimate (`lib/games/play.ts`). It never runs ahead of the server, so the "Claim win on time" button
  never appears early; if a device's own clock is wrong, the claim's stored time corrects the estimate.

## 7. Disappearing messages

Game messages expire with the chat's timer like all messages. **Decision: every game message carries the
whole match, so a game goes on when its earlier messages have disappeared.** A device that no longer has
a game's first messages starts from the oldest one it still has and checks everything after it as usual;
the game screen says so ("Earlier moves have disappeared…"). The games list and the score count what is
still in the chat, so finished games leave the score when their messages expire.

What that means for trust: the position in the oldest surviving message can't be re-checked against moves
that no longer exist. Rule 5 of §4 keeps this safe in practice: my device follows the chain that contains
my own newest message, and my own messages only ever built on positions my device checked while the
earlier messages were still there. The remaining gap: if **every message I sent** in a game has
disappeared and only the other player's are left, my device has to take the oldest one's word. For that an
opponent would have to forge a message after my moves expired, while it has been my turn for a whole timer
period and I never opened the chat. A finished game that names me as a player but holds no message of
mine is never taken on trust (so a score can't be invented).

Other consequences:

- A game nobody touches for the length of the timer disappears with its messages.
- If the timer is **shortened during a game**, the moves made after the change disappear before the
  earlier ones. The game then steps back to the newest move still there (for a short while the two
  players can see different positions: the one whose newer move vanished is one move behind). Don't shorten
  the timer in the middle of a game you care about.

## 8. Hidden chats, blocked people, reports, export

Game messages are messages: a hidden chat's games are hidden with it; a blocked person can't send a move
any more than a text (the insert is refused and the move shows "Not sent"); a game message can be reported
with sender proof like any other; the one-tap export includes the game events of every chat. The dice
secrets are derived on demand and stored nowhere, so there is nothing for a hidden chat or a panic wipe to
leave behind.

## 9. Not included

- **Battleship.** The design is known (commit to the board with salted hashes, reveal per shot, verify the
  whole board at the end), but the secret board has to be remembered across turns and across the player's
  devices, which needs a self-encrypted blob in the game messages and a reveal-and-audit phase in the
  match protocol. It was left out rather than shipped half-checked.
- **No computer opponent**, no ratings, no tournaments.

## 10. Adding a game

1. Write `lib/games/<name>.ts`: a `GameEngine` (`init`, `parse`, `parseMove`, `turn`, `moves`, `play`,
   `outcome`; `dice`, `forced`, `rolled`, `drop` if it needs them). Pure, deterministic, plain-JSON state.
   `parse` must reject anything malformed: states arrive from other people.
2. Add the kind to `GameKind` (`types.ts`) and the engine to `registry.ts`.
3. Add a board to `components/games/boards.tsx`: for a grid game a `GridSpec` (how a cell looks and is
   named, the cells to tap for a move); otherwise a small component using `useArrowKeys`.
4. Add strings: `games.kind.<name>`, `games.blurb.<name>`, `games.rules.<name>` (state the rule set).
5. Tests: rule edge cases, known move counts where they exist, a full game. The shared test in
   `boards.test.ts` plays random games of every registered engine.

Invitations, turns, clocks, draws, resigning, dice, the card, the list and the score need no change.

## 11. Tests

- `packages/crypto/test/games.test.ts`: chain hash is canonical; secrets, commitments, seeds; a fixed
  vector; uniform rolls (chi-square); malformed input.
- `lib/games/chess.test.ts`: perft against the standard counts (start position to depth 4; Kiwipete and
  positions 3, 4, 4 mirrored, 5, 6 to depth 3 or 4); every castling condition; en passant incl. the pinned
  case; promotion choices; checkmate, stalemate, threefold repetition (incl. castling rights), fifty-move
  rule, insufficient material; notation; the Opera Game and a game with castling by both sides, en passant
  and promotions.
- `lib/games/boards.test.ts`: tic-tac-toe (255,168 games), Connect Four (move counts), Reversi (known
  move counts to depth 6, forced pass), checkers (known move counts to depth 6, forced capture, multi-jump,
  crowning ends the turn, kings, blocked, draw), Gomoku, Dots and Boxes, Mancala; random games of every
  engine.
- `lib/games/ludo.test.ts`: every rule in the list above, leaving players, random games for 2–4.
- `lib/games/match.test.ts`: invitations; whole games; refusal of out-of-turn, illegal and misreported
  moves; draw offers; resigning; clocks on server time (early claim, late move, per-move time); dice
  (whole verified three-player game, wrong secret, missing reveal, claimed roll, sixes, dependence on other
  players' messages, players leaving and timing out); malformed messages.
- `lib/games/thread.test.ts`: any arrival order; duplicates; two devices; offline move after a resignation;
  edited messages; a move deleted after it was answered; a made-up position; disappeared history; trust
  rules; moves still being sent; several games; scores.
- End-to-end (Playwright, system Chrome headless, dev server, local Supabase, three fresh passphrase
  accounts, one browser context each; 2026-11-11):
  - *One-to-one, tic-tac-toe.* Invitation from the plus menu, accepted on the card on a 320 px wide
    device, nine moves, draw on both screens; arrow keys move between squares; one card for the game's
    eleven messages; list preview "Tic-tac-toe: Draw"; the Games list with the score table.
  - *One-to-one, chess.* 1. e4 a6 2. e5 f5 3. exf6 a5 4. fxg7 a4 5. gxh8=Q a3 6. Qxg8 axb2 7. Nf3 bxa1=Q
    8. Bd3 Qxb1 9. O-O h6 10. Ne5 h5 11. Qf7#: en passant (offered as a highlighted legal move),
    promotions by both sides through the piece chooser, castling by moving the king two squares,
    checkmate; the same move list on both devices; Black's board turned round.
  - *Illegal move from a modified client.* A second device of Ben whose chess engine was patched as it
    loaded (moves that leave the own king in check no longer filtered) offered and sent the pinned bishop
    f8–g7. Ann's device and Ben's unpatched device both showed "Ben Gamer sent a move that isn't allowed.
    It was ignored." and kept the position; the game went on.
  - *Offline.* With Ann's browser offline, her castling showed on her board at once with "Waiting for a
    connection", Ben saw nothing; back online it was delivered by itself.
  - *Timed game.* Connect Four, 1 minute each: Ben's clock ran down on both devices; "Claim win on time"
    appeared on Ann's device 61.8 s after her move and not before; both ended with "Out of time".
  - *Group, Ludo.* Ann and Ben playing with Cat watching (no controls, "You're watching this game"),
    16 turns; then all three playing, 12 turns, with Ben and Cat accepting at the same moment. After
    every turn all three devices showed the same roll (each derived it from the reveal) and the same
    board; no move was refused anywhere.
  - *The other boards.* Checkers, Reversi, Five in a Row, Dots and Boxes and Mancala: six moves each
    between two devices, one of them 320 px wide, without sideways scrolling of the game screen.
  - *Dark mode, right-to-left, keyboard, reduced motion.* In Arabic with the dark theme the screen
    mirrors and the board doesn't (a8 stays on the left for White). A game was started and its
    invitation withdrawn with the keyboard alone (plus menu, picker, options, game screen).
  - Not run: a real Android device or emulator (the app loads this same web UI in its WebView), a
    screen reader, Safari and Firefox.
