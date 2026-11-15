# Kithwall Privacy Policy

**Effective date:** 15 November 2026
**Last updated:** 15 November 2026

This policy explains what personal data Kithwall handles, why, who else is involved, how long data is
kept, and the rights you have. It applies to the Kithwall website and web app at
[www.kithwall.com](https://www.kithwall.com), the installable web app, and the Kithwall app for Android
(`com.kithwall.app`, from Google Play or as a direct download).

---

## 1. The short version

- What you share with your connections, circles, followers and in messages and calls is **end-to-end
  encrypted on your device**. We store it, but **we cannot read it**.
- We **can** see metadata: your @handle, who you are connected to, who you message and when, how big
  things are, which circles and events you are in, and the other facts listed in section 4.4. We say so
  because encryption cannot hide it.
- Anything you post as **Public** (including public reels) is **not encrypted**. Anyone on the internet
  can read it, with or without a Kithwall account.
- No ads. No tracking. No analytics. No data sales. We never read your address book. No facial
  recognition. No AI reads your content.
- There is no email address and no password. You sign in with a **passkey** (or a passphrase with your
  @handle). If you lose every passkey, your passphrase **and** your 24-word recovery key, and your
  trusted contacts cannot help, **your encrypted content is gone for good**. We cannot recover it.
- You can see everything our servers hold about your account at any time (**Settings → Your data →
  What Kithwall knows about you**), download your data, and delete your account. Deletion is immediate.

---

## 2. Who we are

Kithwall is operated by **Abdul Rehman**, an individual based in **Karachi, Pakistan** ("Kithwall",
"we", "us"). Kithwall is free, carries no advertising and is not run for profit.

| Role | Who |
|---|---|
| Controller (EU/UK GDPR) · Data Fiduciary (India) · Business (California) · Controlador (Brazil) | Abdul Rehman, Karachi, Pakistan |
| Privacy contact, for every request and complaint | **support@kithwall.com** |
| Security reports | security@kithwall.com |
| Grievance Officer (India) | Abdul Rehman, support@kithwall.com (section 15) |
| Data Protection Officer | Not appointed. Kithwall is run by one person and does not meet the legal thresholds that require one. Write to the privacy contact instead |
| EU and UK representative | Not appointed. People in the EU, the EEA and the UK can write to the privacy contact in their own language and will get the same answer, in the same time, as anyone else. We will appoint representatives if the law requires it as Kithwall grows |

---

## 3. Private and Public

Every time you share something you choose who it is for.

| Audience | Encrypted? | Who can read it |
|---|---|---|
| Only me, Connections, Close friends, a Circle, an event, a chat | **Yes**, end-to-end | Only the people you chose. Not us |
| Followers (if you turned on "Let people follow me") | **Yes**, end-to-end | The people who follow you. Not us |
| **Public** posts and public reels | **No** | Anyone on the internet, with or without an account, and us |

- Public is always your choice, per post, and is marked with a globe before you post.
- Public posts, the comments and reactions on them, and the photos and videos attached to them are
  readable by us and by anyone who opens them.
- Search engines are told **not** to list your public posts unless you switch on "Let search engines show
  my public posts" (Settings → Privacy).
- To be followed or to post publicly you must choose a **public name**. It is shown to everyone.
- Kithwall also runs a few clearly labelled **automated accounts** (marked "Automated") that post public
  material from public sources. They hold no personal data about anyone.

---

## 4. What data we handle

### 4.1 Account data (readable by us)

| Data | Why it is not encrypted |
|---|---|
| Your username (@handle) | To address your profile, find people and sign in |
| An internal sign-in identifier made from your account number | Our authentication system needs one. It is not an email address and never receives mail |
| A **notice email address**, only if you add one (Settings → Account) | To send you account notices that contain no content (for example "someone started recovering your account"). It is verified by a link and is never used to sign in |
| Your passkeys' public keys, labels ("Chrome on Android"), counters, and when each was added and last used | To check a passkey sign-in |
| Your **public name**, only if you switch on the people directory ("discoverable") or "Let people follow me" | So people can find and follow you. Otherwise your name is encrypted |
| Your privacy switches: discoverable, follow, read receipts, who may send requests, comment and mention rules, search-engine listing, notification categories | The server has to apply them |
| Your public encryption keys, their history, and entries in the public key log (section 4.10) | Other people's devices need them to encrypt to you and to detect a swapped key |
| Sign-in records: account created, last sign-in, whether two-step sign-in is on, and your active sessions with their IP address and browser | To run sign-in and show you your sessions |
| Account status: active, suspended (and until when), memorialised; staff role, if you are a moderator | To run the service |

**Your passkey and passphrase never reach us.** A passkey stays on your device (or in your platform's
passkey sync). A passphrase is turned into two separate keys on your device: one signs you in (we store
only a one-way hash of it), the other unlocks your encryption keys and never leaves your device.

We also store your **key bundle**: your encryption keys, each locked with a key we never see. We cannot
unlock it.

### 4.2 Encrypted content (not readable by us)

Encrypted on your device before it is sent. We store only ciphertext.

- Posts, comments, links and their previews (for every audience except Public)
- Photos, albums, videos, reels and stories (for every audience except Public). Location and camera data
  are stripped from photos on your device before upload
- Messages, group chats, voice notes, reactions, poll votes, game moves
- Voice and video calls: sound and picture travel end-to-end encrypted and are never stored
- Your profile: name, picture, bio and details
- The names of your circles and lists; private groups and events and what is in them
- The text of notification previews
- Notes on connection requests; your private settings, hidden chats and saved items
- Safety check-in messages and any location you attach to one
- Recovery shares held by your trusted contacts; notes for your legacy contact

Because we cannot read this content, we **do not and cannot** scan it, analyse it, profile you from it,
train AI on it, or show it to anyone. The one exception is when someone who can see an item **reports**
it (section 8).

### 4.3 Public content (readable by us and by everyone)

- The text, links, photos and videos of your **Public** posts and public reels
- Comments and reactions on Public posts
- Your @handle and public name

### 4.4 Metadata (readable by us)

Encryption hides *what* you say, not *that* you said something. To deliver your content to the right
people our servers can see:

| Metadata | Example |
|---|---|
| Connections, requests, follows, blocks and restrictions, with dates | "A and B connected on 3 March" |
| Who is in each conversation, when messages are sent, edited or unsent, and read state | "A messaged B at 21:04; B read it at 21:10" |
| Who posted, to which audience, what kind of item, when, and roughly how big it is; scheduled and disappearing timers | "A posted a 3 KB item to A's Close friends" |
| That someone liked or reacted to an item or a comment (the emoji itself is encrypted), or voted in a poll | "C reacted to post #123" |
| Who commented on which post, and when | |
| Circle, group and event membership, roles and RSVPs | "A is an admin of circle #9" |
| That a person was tagged in an item | |
| Stories: who posted one and who viewed it, and when | |
| Notification records: recipient, type, who caused it, which item, read or unread | |
| Calls: one record per call (who called, in which conversation, when, voice or video, answered or not). No recording, no duration | |
| Trusted contacts for recovery, and recovery requests and their status | |
| Safety check-ins: that one exists, its deadline, and which chats would be alerted | |
| Legacy contact, if you set one: who it is, the waiting period, and the date you were last active (to the day) | |
| Invite links you made and how often they were used | |
| File sizes and upload times | |
| Reports you make or that concern your content (section 8) | |
| Online and typing status, while you are online, unless you "Go offline" | Passes through our realtime service; not stored |

### 4.5 Technical and log data

| Data | Who holds it | Notes |
|---|---|---|
| IP address, time and request details of sign-in, sign-up, recovery and API calls | Supabase (authentication and API logs) | Kept 7 days |
| IP address, browser type and the page address requested (which can include a username or a public post) | Vercel (hosting and request logs) | Kept only briefly, for operations. Vercel Web Analytics is **off**. If a direct connection to our database is blocked on your network, the app can send its requests through the same hosting |
| Spam and abuse limits | Our database | For signed-in actions: your account, the kind of action and the time, kept 7 days. For sign-in, sign-up and recovery pages: a keyed hash of your IP address that changes every day and cannot be turned back into the address without our key, kept 2 days (with a recovery request, until that request is deleted) |
| Proof-of-work check at sign-up | Our server (self-hosted ALTCHA) | No third party, no cookies. The used token is kept 1 day so it cannot be reused |
| Email delivery records, if you added a notice email | Spacemail by Spaceship | Recipient, time, status. The emails contain no post or message content |
| Crash reports, **only if you turn on "Send crash reports"** (off by default) | Our own database; no third-party service | What broke (error type, a scrubbed message, code location), app version, operating system and browser with major version, the kind of screen and the interface language. No account, session, device identifier or IP address is stored with it. Deleted after 30 days |

### 4.6 Calls

Voice and video calls are end-to-end encrypted between the people in the call. To connect the call:

- signalling messages travel through our realtime service, sealed so we cannot read them; the service
  sees which accounts joined which call and when;
- by default calls are **relayed** through Cloudflare's relay network ("Always relay calls" is on), so
  the other person sees a Cloudflare address instead of your IP address. Cloudflare sees the IP addresses
  of both ends, timing and packet sizes, but cannot see or hear the call. If you turn "Always relay
  calls" off, calls can connect directly and the other person's device can see your IP address.

### 4.7 The Android app, and permissions

The Android app shows the same Kithwall service as the website. It asks for a permission only when you
use the feature that needs it:

| Permission | Used for | Reaches our servers readable? |
|---|---|---|
| Camera | Photos, video calls, scanning a safety-number code | No |
| Microphone | Voice notes and calls | No |
| Location (approximate or precise) | Only when you tap "Attach my location now" on a safety check-in: one reading, sealed for the people you chose. Never in the background | No |
| Notifications | Showing notifications, if you turn them on | See 4.9 |
| Fingerprint or face unlock | Optional app unlock. Android does the check; we never receive biometric data | No |
| Screenshot detection (Android 14+) | Showing you a local notice after a screenshot. Nobody else is told | No |

The app contains no advertising or analytics software and does not use the advertising ID. The Google
Play version uses Google's push delivery (4.9), Google's passkey manager and Google's on-device
translation; the direct-download version contains no Google software.

### 4.8 Data kept on your device

This stays on your device and is not sent to us:

- your unlocked keys while the app is open, and (if you choose "Keep me logged in") a copy locked to the
  device; on Android, keys are held in the Android Keystore;
- an encrypted cache of content you have opened, and the offline kit (section 13);
- **Search on this phone:** an index of text this device has decrypted, encrypted on the device. Your
  search words never leave the device;
- **Reels:** what kinds of reels you watch is remembered only on the device, to order your feed. It is
  never uploaded;
- **Blur faces** and **translation** run on your device. Downloading a translation language pack is a
  request from your device to Google or your browser maker; the text you translate is not sent to us;
- your app PIN, duress PIN and hidden-chat settings.

### 4.9 Push notifications (optional)

If you turn on notifications for a device we store, for that device, the address or token your browser
or phone gives us for delivery, an encryption key for it, a coarse label such as "Chrome on Android" or
"Kithwall app on Android", when it was added, when a notification last got through, and which kinds of
activity you want.

- **What a notification says:** only *who* did *what* ("dan sent you a message"), using the person's
  @handle or public name. It never contains the text of a message, post or comment. Hidden chats say only
  "You have new activity".
- **Who carries it:** your browser's push service (Google, Apple, Mozilla or Microsoft), or on the
  Android app **Google Firebase Cloud Messaging** (Google Play version) or the UnifiedPush app you chose
  (direct-download version). Every notification is **encrypted for your device** before it leaves our
  server, so the carrier cannot read it. The carrier does learn that a notification was sent to your
  device, when, and roughly how big it was.
- **Turning it off:** Settings → Notifications removes the device's record at once.

### 4.10 The public key log

So that nobody (including us) can quietly swap someone's encryption key, each key change is added to a
public, append-only log as a salted fingerprint that reveals nothing by itself. A copy of the log's daily
summary is published on GitHub. The values that link an entry to your account are shown only to people
who can already see your profile, and are deleted with your account; the fingerprints stay in the log.

### 4.11 Link previews and embedded video

- **Link previews.** When you add a link to a post or tap "Add link preview" in a chat, your device asks
  our server to fetch the page's title and picture, so the website sees our server and not you. The link
  passes through our server for a moment and is not logged or stored by us. The finished preview is
  encrypted with your post or message.
- **Embedded video** (YouTube, Vimeo, Dailymotion, Streamable, TikTok). Nothing loads from the provider
  until you press play. When you do, the provider's player loads on your device and that provider sees
  your IP address and applies its own privacy policy.
- **Links you open** leave Kithwall and are governed by the site you visit.

### 4.12 Support and legal communications

If you email us we receive your email address and whatever you write. **Email is not end-to-end
encrypted.** Please do not send us sensitive content unless you need to.

### 4.13 What we never collect

- Your address book or contacts
- Your location, except the single sealed reading you choose to attach to a safety check-in
- Photo location or camera metadata (stripped on your device)
- Biometric data; we do no facial recognition
- Payment details (Kithwall is free; there is nothing to buy and we take no payments)
- Advertising identifiers, or data from advertising networks, data brokers or trackers
- Phone numbers
- What you watch, how long you look at something, or what you search for

---

## 5. Why we use your data, and our legal bases

| Purpose | Data used | Legal basis (EU/UK GDPR) |
|---|---|---|
| Create and run your account; sign you in; keep sessions | Account data, sign-in records, technical data | Contract (Art. 6(1)(b)) |
| Store your content and deliver it to the audiences you choose; calls; stories; reels | Encrypted content, public content, metadata | Contract |
| Show Public posts to everyone, and list them in Explore | Public content, public name, @handle | Contract; it is what you ask for when you post publicly |
| People directory and follow | @handle, public name, your switches | Contract; only if you switch them on |
| Send content-free account notices to your notice email | Notice email address | Contract; legitimate interests in account security (Art. 6(1)(f)) |
| Push notifications | Device push record, your choices, notification metadata | Consent (Art. 6(1)(a)); you turn it on per device and can turn it off at any time |
| Crash reports | The report described in 4.5 | Consent; off unless you turn it on |
| Account recovery with trusted contacts; legacy contact; safety check-ins | The records listed in 4.4 | Contract; only if you set them up |
| Security; preventing spam and abuse | Technical data, rate limits, metadata | Legitimate interests in keeping the service and its users safe |
| Handling reports, enforcing our Terms and Community Standards, appeals | Reports (including what the reporter disclosed), metadata about the accounts involved | Legitimate interests in a safe service; legal obligation where the law requires action (Art. 6(1)(c)) |
| Reporting child sexual abuse material to the authorities | Reported content and related metadata | Legal obligation; otherwise legitimate interests and vital interests |
| Responding to valid legal requests and emergencies | Account data, metadata, reports | Legal obligation; vital interests (Art. 6(1)(d)) for emergencies |
| Answering your emails | Your email and message | Legitimate interests in answering you; contract |
| Backups and disaster recovery | Everything stored (ciphertext and metadata) | Legitimate interests in not losing your data |

Where another country's law uses different words, the same purposes apply: for example **consent** and
**legitimate uses** under India's Digital Personal Data Protection Act 2023, and **performance of a
contract**, **legitimate interest**, **consent** and **legal obligation** under Brazil's LGPD.

**Sensitive information.** You may share things that reveal health, religion, politics, sexuality or
similar. When it is encrypted we cannot read it and do not process it in readable form. If you post it
as **Public**, you have chosen to make it public. If it is **reported**, moderators see it only to
handle the report, as needed to protect users and to deal with legal claims.

**Automated decisions.** We use automatic rate limits and a sign-up proof-of-work to stop abuse; these
can briefly stop an action (for example sending too many requests in a day). A Public post that several
different people report is **hidden automatically until a moderator has looked at it**. None of this
makes decisions about you with legal or similarly significant effects. Warnings, suspensions and bans
are decided by a person, and you can appeal.

**No profiling, no ads, no sale.** We do not use your data for advertising or profiling. "Popular" in
Explore is ordered only by public signals on public posts (reactions, comments, age), the same for
everyone. Your own feed is in time order, and reels are ordered on your device.

**We do not train AI on your data**, and no AI system reads your content.

---

## 6. What we cannot access, and the honest limits

| We cannot | Because |
|---|---|
| Read your encrypted posts, photos, messages, calls, profile details or notification previews | They are encrypted on your device with keys we never receive |
| Reset your sign-in and keep your content, or recover content if you lose every key | Nobody holds a spare key. This is by design |
| Hand your encrypted content to anyone, including the police | We do not have it in readable form |
| Search, scan or analyse your encrypted content | Same reason |

Limits you should know about:

- **Metadata** (section 4.4) is visible to us.
- **Public** content is not encrypted.
- **The app is delivered by our servers.** A malicious or compromised version of the app could steal
  keys. We reduce this risk by loading no third-party scripts and by publishing the source code: Kithwall
  is open source under the GNU Affero General Public License v3.0 at
  [github.com/443abdul/kithwall](https://github.com/443abdul/kithwall), and the app links to the exact
  version it is running.
- **Your device.** Malware, or a browser extension with access to the page, can read what you see.
- **The people you share with** can screenshot or copy what you share.
- **No forward secrecy for stored content.** If someone later obtains your account key and the stored
  ciphertext, they could decrypt your past content.
- **Reports.** If someone who can see your content reports it, they disclose that item to our moderators
  (section 8).

---

## 7. Who we share data with

We do not sell, rent or trade personal data, and we share none of it for advertising. Data reaches
others only as follows.

### 7.1 Service providers

| Provider | What it does for us | Data it handles | Where |
|---|---|---|---|
| **Supabase, Inc.** | Database, sign-in, file storage, realtime delivery, backups | Account data, ciphertext, public content, metadata, sign-in and API logs (with IP addresses) | Data stored in **Mumbai, India**; company in the USA |
| **Vercel Inc.** | Hosting the website and app, server functions (sign-up check, account deletion, link previews, notifications) | IP address, browser type, page address; links passing through the preview fetcher (not stored by us) | Worldwide network; company in the USA |
| **Cloudflare, Inc.** | Relaying calls | IP addresses of the two ends of a call, timing and size of encrypted packets | Worldwide network; company in the USA |
| **Spaceship, Inc.** (Spacemail) | Sending account notices and receiving your emails to us | Your notice email address, delivery records, emails you send us | USA |
| **Google LLC** (Firebase Cloud Messaging) | Delivering encrypted notifications to the Google Play app | A device token and the encrypted notification | Worldwide; company in the USA |

These providers act for us, under their data-processing terms, and may use the data only to provide
their service. Their own sub-processors are listed on their websites.

### 7.2 Services your own device talks to

These are chosen by your device or by you, and operate under their own terms:

- your browser's push service (Google, Apple, Mozilla, Microsoft), or your UnifiedPush app (4.9);
- your passkey manager (for example Google Password Manager or iCloud Keychain), if you sync passkeys;
- Google, when the Google Play app downloads a translation language pack;
- a video provider, after you press play (4.11);
- GitHub, if you download the Android app from there or use "Compare with witness" on the key log.

### 7.3 Other people

Other people see what you share with them. Everyone can see your @handle, your public name if you set
one, your public keys and anything you post as Public. Your connections can see who you follow unless
you switch that off.

### 7.4 Moderators

Moderators are specially appointed accounts. They see reported items and related account metadata
(section 8), and nothing else.

### 7.5 Legal requests and safety

We disclose data when a law that applies to us requires it, or in an emergency involving a risk of death
or serious injury. We can only disclose what we have: account data, metadata, public content and reports.
See our [Law Enforcement Guidelines](law-enforcement-guidelines.md). We report child sexual abuse
material as the law requires.

### 7.6 A change of operator

If Kithwall is ever handed to a new operator, your data would move with it under this policy, and we
would tell you beforehand. Your encrypted content would stay unreadable to the new operator too.

---

## 8. Reporting and moderation

- When you report an item, **your device sends our moderators a readable copy of that item** and the
  proof needed to confirm it matches what is stored, so that reports cannot be faked.
- For a post, that proof also unlocks the comments on that post and the photos attached to it.
  Moderators are instructed to look only at what they need to decide the report.
- A report of a message includes proof that the message really was sent by the person reported.
- Public posts and comments are readable anyway; a report records a copy as it was when reported.
- The person whose content is reported is not told who reported it.
- Reports are kept for **1 year after they are resolved**, longer only where the law requires it (for
  example, material that must be preserved for the authorities).

---

## 9. Where your data is processed

Your data is stored in **India (Mumbai)**. It is also handled by the providers in section 7, which are
based in the **United States** and run worldwide networks. Kithwall itself is run from **Pakistan**,
where the operator handles reports, support and administration.

These countries may not have data-protection laws equivalent to those where you live. Safeguards:

| From | Safeguard |
|---|---|
| EU / EEA | The European Commission's Standard Contractual Clauses in our providers' data-processing terms; the EU–US Data Privacy Framework for providers certified under it |
| United Kingdom | The UK International Data Transfer Addendum; the UK–US Data Bridge for certified providers |
| Switzerland | The Standard Contractual Clauses as adapted for Switzerland; the Swiss–US Data Privacy Framework for certified providers |
| India | Transfers are permitted under the Digital Personal Data Protection Act 2023 except to countries the Central Government restricts |
| Other countries | Your data is handled as this policy describes wherever it is processed. Where your law requires your consent to process your data abroad, you give it by creating an account, and you can withdraw it by deleting your account |

The strongest safeguard is technical: most of what we hold is ciphertext that neither we nor any
provider can read. Account data, public content and metadata are readable. You can ask for a copy of the
contractual safeguards at support@kithwall.com.

---

## 10. How long we keep data

| Data | How long |
|---|---|
| Your content (encrypted or public) | Until you delete it. Deletion from the database is immediate |
| Stories | 24 hours |
| Disappearing messages and posts | Until the timer you set runs out |
| Unsent messages | The record that a message was unsent is removed after 10 minutes |
| Account data and key bundle | Until you delete your account |
| Connections, follows, memberships, reactions and other metadata | Until you or the other person removes them, or the account is deleted |
| Your whole account, when you delete it | Removed at once, with every file. Your keys are destroyed, so encrypted copies in backups can never be read |
| Backups | 7 days |
| Notifications | 90 days |
| Device push records | Until you turn notifications off on that device, the carrier reports the device gone, or you delete your account |
| Recovery requests | 7 days after they end |
| Trusted-contact recovery shares; legacy contact | Until you change them or delete your account |
| Safety check-ins | Until you cancel them; 7 days after an alert was sent |
| Reports | 1 year after they are resolved (longer only if the law requires) |
| Moderation decisions about an account | 1 year, or until the decision stops applying if that is later |
| Spam and abuse counters | 7 days; the daily IP hash 2 days |
| Sign-in challenges and email-verification links | Hours to 1 day after they expire |
| Uploads that were never attached to anything | 1 day |
| Sign-in and API logs (with IP addresses) | 7 days |
| Hosting request logs | Kept only briefly by the hosting provider |
| Crash reports (only if you turned them on) | 30 days |
| Public key log | Fingerprints stay permanently; the values linking them to you are deleted with your account |
| Emails you send us | Up to 2 years after the conversation ends |
| Records of legal requests | 3 years |
| Data on your device | Until you log out, wipe the device from the Safety centre, or clear the app's data |

We do not delete accounts for being inactive.

**Copies held by other people.** People you shared with may keep copies (screenshots, their own exports,
their device's cache until they log out). Public posts may have been copied or indexed by others while
they were public. Deleting your account cannot reach those.

---

## 11. Your rights

We give **everyone** these rights, wherever they live.

| Right | How it works on Kithwall |
|---|---|
| **Know and access** | **Settings → Your data → What Kithwall knows about you** shows, live, every kind of record our servers hold about your account. **Download my data** builds a file of your decrypted content on your device (we cannot do this for you, because we cannot decrypt it). For anything else, write to us |
| **Portability** | The download is in open, machine-readable formats |
| **Correction** | Edit your profile and content in the app; change or remove your notice email in Settings. For anything else, write to us |
| **Deletion** | See 11.1 |
| **Restrict or object** | Write to us. You can object to anything we do on the basis of legitimate interests; we will stop unless we have compelling reasons (for example security) |
| **Withdraw consent** | Turn off notifications, crash reports, the directory, follow or any other optional feature in Settings. This does not affect what happened before |
| **Not be discriminated against** | We never treat you differently for using your rights |
| **Complain** | To us first, if you will: support@kithwall.com. You can also complain to your data-protection authority (section 14) |

### 11.1 Deleting your account and data

- **In the app or on the web:** sign in at [www.kithwall.com](https://www.kithwall.com) or in the Android
  app, then **Settings → Your data → Delete my account**. Deletion is immediate and permanent: your account,
  every post, photo, message, connection and file is removed, and your keys are destroyed. Backups age
  out within 7 days and cannot be read without your keys.
- **You can also delete single items** (a post, a photo, a message) at any time.
- **If you cannot sign in:** first use your recovery key or trusted contacts at
  [www.kithwall.com/recover](https://www.kithwall.com/recover). Kithwall accounts have no email address or
  phone number, so we normally have no other way to confirm that an account is yours. If you added a
  **notice email** to the account, write to support@kithwall.com from that address and we will delete the
  account after confirming the request with you. If you did not, we cannot verify you and cannot act on
  the account; no law requires us to collect more data just to do so.
- **What is kept after deletion:** nothing that identifies you, except records we must keep by law (for
  example a report preserved for the authorities) and the permanent fingerprints in the public key log,
  which no longer link to you.

### 11.2 How to make a request

- Email **support@kithwall.com** and tell us your @handle.
- We may ask you to show that you control the account, for example by replying from your verified notice
  email. We will **never** ask for your passphrase or recovery key. Do not give them to anyone.
- We answer within **30 days**. If a request is complex we may need up to 60 more days, and will tell you
  why. Requests are free unless clearly unfounded or excessive.
- Someone you authorise can make a request for you; we will need proof of their authority.
- If we refuse a request we will say why, and you can ask us to look again by replying with "Appeal".

---

## 12. Children

- You must be **at least 16** to use Kithwall, and **at least 18 if you live in India**, or older if the
  law where you live requires it. You confirm this when you create your account.
- Kithwall is **not directed at children under 13** and we do not knowingly collect personal data from
  them.
- If we learn that an account belongs to someone under the minimum age we will delete it. Because we
  cannot read encrypted content, we rely on what you confirm at sign-up and on reports. If you believe a
  child is using Kithwall, write to support@kithwall.com.
- Parents and guardians can write to the same address to ask for a child's account to be removed.

---

## 13. Cookies and storage on your device

Kithwall uses **no advertising, analytics or tracking cookies** and nothing from third parties. It uses
only storage that is **strictly necessary** to provide the service you asked for, which does not need
consent under EU and UK rules, so there is no cookie banner.

| Item | Purpose | Lifetime |
|---|---|---|
| Sign-in session | Keeps you signed in | Until you log out; refreshed every hour |
| Locked copy of your account key ("Keep me logged in" only), app PIN record | Lets the app unlock without your passkey or passphrase | Until you log out |
| Encrypted cache and offline kit | Makes the app fast and usable with no connection; content stays encrypted with a key from your account | Until you log out |
| Search index ("Search on this phone") | Searching your own chats and posts on the device | Until you log out or switch it off |
| Reels preferences | Ordering your reels on the device | Until you log out |
| Service worker and the app's own files | Receiving notifications; opening the app offline. It never stores your posts or messages | Until you log out or a new version replaces them |
| Small settings flags (language, theme, notification and connection choices) | Remembering your choices on this device | Until you clear the app's data |

The app locks itself after a period of inactivity (30 minutes unless you change it), which wipes keys
from memory. If we ever add storage that is not essential we will ask first.

---

## 14. Information for particular countries

Section 11 applies everywhere. This section adds what local law asks us to say.

### 14.1 European Economic Area, United Kingdom and Switzerland

- The controller is named in section 2; legal bases are in section 5; transfers in section 9.
- You can complain to the data-protection authority where you live or work. In the UK that is the
  Information Commissioner's Office ([ico.org.uk](https://ico.org.uk)); in Switzerland the Federal Data
  Protection and Information Commissioner.
- If you complain to us we will acknowledge it within 30 days and tell you the outcome without undue
  delay.
- You are not required by law or contract to give us any personal data, but we cannot give you an account
  without a @handle and a way to sign in.

### 14.2 United States, including California

These laws apply to businesses above certain sizes, which Kithwall is not. We follow them anyway.

- We **do not sell** personal information and **do not share** it for cross-context behavioural or
  targeted advertising, and have not in the past 12 months. We do not knowingly sell or share the
  personal information of anyone under 16.
- We honour **Global Privacy Control** signals, though there is nothing to opt out of.
- We do not use or disclose sensitive personal information to infer characteristics about you.
- You have the rights to know, access, correct, delete and port your information, and not to be treated
  differently for using them. You can use an authorised agent. If we decline a request you can appeal by
  replying with "Appeal"; if the appeal fails you may contact your state's Attorney General.

Categories collected in the last 12 months (sources, purposes, recipients and retention are in sections
4, 5, 7 and 10):

| Category | Collected? | Example |
|---|---|---|
| Identifiers | Yes | @handle, public name if set, notice email if added, IP address (in logs), device push token if notifications are on |
| Customer records | Only if you add a notice email | Notice email address |
| Characteristics of protected classifications | Only if you post them publicly | — |
| Commercial information; biometric information; precise geolocation; inferences | No | — |
| Internet or network activity | Yes, limited | Sign-in logs, request logs, the metadata in section 4.4 |
| Audio, electronic, visual | Only what you post as Public; everything else is encrypted and unreadable to us | Public photos and videos |
| Professional or education information | Only if you post it publicly | — |
| Sensitive personal information | Account sign-in data (passkey public keys, or a one-way hash derived from your passphrase) | — |

### 14.3 Canada

We collect, use and disclose personal information with your knowledge and consent, for the purposes in
section 5. Your information is stored and processed outside Canada (section 9), where the authorities of
those countries may be able to obtain it under their laws. You can ask for access or correction, and you
can complain to the Office of the Privacy Commissioner of Canada or your provincial commissioner.

### 14.4 Brazil

Under the LGPD you can ask us to confirm that we process your data, give you access, correct it,
anonymise, block or delete it, port it, tell you who we share it with, and you can withdraw consent. The
contact for data-protection matters is the privacy contact in section 2. You can complain to the
Autoridade Nacional de Proteção de Dados (ANPD).

### 14.5 India

- We process your data on the basis of the consent you give when you create your account and for the
  legitimate uses the law allows. You can withdraw consent by turning features off or deleting your
  account.
- You may **nominate** a person to exercise your rights if you die or become unable to. Write to the
  Grievance Officer with their name and email. A nominee cannot read your encrypted content unless you
  gave them your recovery key.
- People under 18 may not use Kithwall in India.
- Complaints go first to the Grievance Officer (section 15), then to the Data Protection Board of India.

### 14.6 Pakistan

Kithwall is run from Pakistan. We handle your data with the care this policy describes and in line with
the Prevention of Electronic Crimes Act 2016 and other laws that apply to us. You have every right in
section 11, and we will follow Pakistan's personal data protection law as it comes into force.

### 14.7 Australia and New Zealand

You can ask for access to and correction of your personal information. Your information is held outside
Australia and New Zealand (section 9). If you are not satisfied with our answer you can complain to the
Office of the Australian Information Commissioner or the New Zealand Privacy Commissioner. People under
16 may not use Kithwall.

### 14.8 Everywhere else

If your country's law gives you rights beyond section 11, you have them here too. This includes, among
others, Japan, South Korea, Singapore, Malaysia, Indonesia, the Philippines, Thailand, Vietnam, China,
Turkey, the United Arab Emirates, Saudi Arabia, South Africa, Nigeria, Kenya, Egypt, Mexico, Argentina,
Chile and Colombia. Write to support@kithwall.com; you can also complain to your national
data-protection authority.

---

## 15. Grievance Officer (India) and complaints

**Grievance Officer:** Abdul Rehman
**Email:** support@kithwall.com (put "Grievance" in the subject)
**Address:** Karachi, Pakistan

We acknowledge complaints within **24 hours** and aim to resolve them within **15 days**. If you are not
satisfied you may complain to the Data Protection Board of India.

---

## 16. Security

- End-to-end encryption with well-reviewed open-source cryptography (XChaCha20-Poly1305, X25519 with
  ML-KEM-768 for post-quantum protection, Ed25519, Argon2id).
- Your passkeys' secrets, your passphrase and your recovery key never leave your device.
- Every item is signed by its author, so the server cannot alter or swap it without detection.
- The database denies everything by default; each account can fetch only what it is allowed to.
- All connections use TLS. Strict browser security headers; no third-party scripts.
- Optional two-step sign-in; a session list with "log out other sessions"; app PIN, duress PIN, and
  "wipe this device".
- Deleting your account or changing recovery needs proof from your own device's keys, so a stolen session
  alone cannot destroy your account.
- Recovery requests notify you and wait 24 hours before trusted contacts can help.

No system is perfectly secure. Please use a passkey (or a strong, unique passphrase) and keep your
24-word recovery key somewhere safe and offline. Report security problems to security@kithwall.com.

---

## 17. Data breaches

If a breach affects your personal data we will:

- tell the people affected **without undue delay**, in the app and by notice email where we have one,
  saying what happened, what data was involved and what to do;
- notify the data-protection authorities the law requires, within the time it sets (for example within
  **72 hours** under the EU and UK GDPR, and the Data Protection Board of India and affected users in
  India as Indian law requires).

Because content is end-to-end encrypted, a breach of our servers would expose **ciphertext, metadata,
account data and public content**, not the readable content of your private posts, messages or calls.

---

## 18. Changes to this policy

We will post changes here and update the date at the top. For changes that matter (a new provider, a new
use of data, a new kind of data), we will tell you in the app **at least 30 days** before they take
effect, unless the change is needed urgently by law or for security. Earlier versions are in the public
history of this file at
[github.com/443abdul/kithwall](https://github.com/443abdul/kithwall/commits/main/docs/legal/privacy-policy.md).

---

## 19. Contact

- Privacy questions, requests and complaints: **support@kithwall.com**
- Security problems: **security@kithwall.com**
- Operator: Abdul Rehman, Karachi, Pakistan

Related documents: [Terms of Service](terms-of-service.md) ·
[Community Standards](community-standards.md) ·
[Law Enforcement Guidelines](law-enforcement-guidelines.md)
