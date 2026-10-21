# Kithwall Privacy Policy

> **DRAFT v0.1 (2026-10-17) — not yet reviewed by a lawyer. Do not publish until every
> `[PLACEHOLDER]` is filled and counsel has signed off.**

**Effective date:** [EFFECTIVE DATE]
**Last updated:** [LAST UPDATED DATE]

---

## 1. The short version

- What you share on Kithwall with friends, lists, groups and events is **end-to-end encrypted on
  your device**. We store it, but **we cannot read it**.
- We **can** see metadata: your email address, who your friends are, who you message and when, how
  big things are, which groups and events you're in, and similar facts listed in section 4.3. We are
  honest about this because encryption cannot hide it.
- Anything you post as **Public** is **not encrypted**. (Public posting is switched off at launch;
  see section 3.)
- No ads. No tracking. No third-party analytics or scripts. We never sell or share your data for
  advertising. We never upload your address book. No facial recognition. No AI reads your content.
- If you lose your password **and** your 24-word recovery key **and** cannot get help from your
  trusted friends, **your encrypted content is gone for good**. We cannot recover it for you.
- You can export everything (decrypted on your device) and delete your account at any time.
  Deletion is immediate.

---

## 2. Who we are

Kithwall is operated by **[OPERATOR LEGAL NAME]**, [OPERATOR LEGAL FORM, e.g. sole trader /
company], registered at **[OPERATOR REGISTERED ADDRESS]** ("Kithwall", "we", "us").

| Role | Who |
|---|---|
| Controller (GDPR / UK GDPR) / Data Fiduciary (India DPDP Act 2023) / Business (California) | [OPERATOR LEGAL NAME] |
| Privacy contact | [PRIVACY CONTACT EMAIL] |
| Grievance Officer (India) | [GRIEVANCE OFFICER NAME], [GRIEVANCE OFFICER EMAIL], [GRIEVANCE OFFICER ADDRESS] — see section 15 |
| EU representative (GDPR Art. 27), if required | [EU REPRESENTATIVE NAME AND ADDRESS / "Not required because …"] |
| UK representative (UK GDPR Art. 27), if required | [UK REPRESENTATIVE NAME AND ADDRESS / "Not required because …"] |
| Data Protection Officer, if appointed | [DPO NAME AND EMAIL / "Not appointed"] |

This policy covers the Kithwall website and web app at [SERVICE DOMAIN], including the installable
app version (PWA). It also covers emails we send you.

---

## 3. Friends-only at launch, and what changes if Public is turned on

| | At launch | If we later switch on the Public audience |
|---|---|---|
| Who can see your posts, photos, profile details | Only the audiences you choose: Only Me, Friends, or Custom lists/people. All encrypted. | You may also choose **Public** for individual items |
| Public content | None, except your username and any profile picture or display name you choose to make visible (see 4.1) | Public items are stored **unencrypted**, are readable by us, and are visible to anyone signed in to Kithwall [and, if we enable it, to people who are not signed in] |
| Pages, Open Groups, public events | Not available, or available only in encrypted form | Available; these are public by nature and **not encrypted** |

Public items are always marked with a globe and "Public — not encrypted" before you post. We will
update this policy and tell you in the app before Public is switched on.

---

## 4. What data we handle

### 4.1 Account data (readable by us)

| Data | Why it is not encrypted |
|---|---|
| Email address | Needed to sign you in, confirm your account, reset your password and send service emails |
| Username | Needed to address your profile and find friends |
| Display name, if you set one and either turn on "discoverable" or share it with friends | Needed for people search and friend requests. [OWNER: confirm which name fields are stored unencrypted] |
| Whether you are in the people directory ("discoverable") | Needed for search |
| Profile picture, **only if** you mark it Public | Public by your choice |
| Your public keys and a history of key changes | Other people's devices need them to encrypt to you and to check that a key change is genuine |
| Authentication records: account created date, last sign-in, MFA enabled (yes/no), active sessions | Needed to run sign-in and show you your sessions |

**Your password never reaches us.** Your device turns it into two separate keys. One signs you in
(our authentication provider stores only a one-way hash of it). The other unlocks your encryption
keys and never leaves your device.

We also store your **key bundle**: your encryption keys, each locked with a key we never see
(derived from your password or your 24-word recovery key). We cannot unlock it.

### 4.2 Encrypted content (not readable by us)

Encrypted on your device before it is sent. We store only ciphertext.

- Posts, status updates, wall posts, comments, shared links and their previews
- Photos and albums (location and camera data is stripped from photos on your device before upload)
- Photo tags, and the text and identity of who is tagged in the post or photo itself (but see the
  tag notification row in 4.3)
- Messages and chat
- Profile details (Education & Work, Basic Info, Likes, Contact, Philosophy, Arts, Sports and similar)
- Notes, questions/polls and your poll votes, Places check-ins (place and tagged friends)
- Events and groups that are private, closed or secret: names, descriptions, details, walls
- Names of your friend lists
- Readable notification previews (e.g. "Kevin commented: …")
- Your private settings and your Kithville game state
- Optional notes attached to friend requests

Because we cannot read this content, we **do not and cannot** scan it, analyse it, profile you from
it, train AI on it, or show it to anyone. The one exception is when someone **reports** an item: see
section 8.

### 4.3 Metadata (readable by us)

Encryption hides *what* you say, not *that* you said something. To route your content to the right
people, our servers can see:

| Metadata | Example |
|---|---|
| Your friendships and friend requests, with dates | "A and B became friends on 3 March" |
| Who is in each conversation, when messages are sent, read receipts | "A messaged B at 21:04; B read it at 21:10" |
| Who posted, on whose wall, to which audience, when, and roughly how big it is | "A posted a 3 KB item to B's wall for A's Friends audience" |
| Likes on items (as rows: who liked which item), even on encrypted items | "C liked post #123" |
| Who commented on which post, and when | |
| Group and event membership, roles, RSVPs | "A is an admin of group #9; B was invited to event #4" |
| Who is a member of each of your friend lists (but not the list's name) | |
| Pokes | "A poked B at 10:15" |
| That a person was tagged in a particular photo or post, and whether they approved | "B was tagged in photo #77 (approved)" |
| Who voted in a poll (but not how they voted) | |
| Pages you like (visible only to you in the app, but stored on our servers) | |
| Notification records: recipient, type, who triggered it, which item, read/unread | |
| Your trusted friends for recovery, and recovery requests and their status | |
| Invite links you created and how often they were used | |
| Media file sizes and upload times | |
| Reports you make or that concern your content (see section 8) | |
| Online / typing status, while you're online, unless you turn it off ("Go offline") | Passes through our realtime service; not stored |

### 4.4 Technical and log data

| Data | Who holds it | Notes |
|---|---|---|
| IP address, time, and request details of sign-in, sign-up and password reset | Supabase (authentication logs) | Our app tables do not store IP addresses or user agents |
| IP address and request details of API calls from your browser | Supabase (platform/API gateway logs) | Kept per Supabase's log retention (section 10) |
| IP address, user agent, page address requested (which can include a username, e.g. /alice) | Vercel (hosting/CDN request logs) | Vercel Web Analytics is **off**. Kept per Vercel's log retention (section 10) |
| Proof-of-work captcha challenge result at sign-up | Our server (self-hosted ALTCHA) | No third party, no cookies, not stored after the check |
| Email delivery records (recipient address, time, status) | Spacemail by Spaceship | Emails contain no post or message content |

### 4.5 Data stored on your device

See section 13 (cookies and local storage). This data stays on your device and is not sent to us,
except where stated.

### 4.6 Support and legal communications

If you email us, we receive your email address and whatever you write. **Email is not end-to-end
encrypted.** Please don't send us sensitive content unless you need to.

### 4.7 What we never collect

- Your address book or contacts (we never upload it)
- Your location in the background (location is used only when you press Check In, and the place you
  choose is encrypted)
- Photo location/camera metadata (stripped on your device)
- Biometric data; we do no facial recognition
- Payment details (Kithwall is free; there is nothing to buy)
- Data from advertising networks, data brokers, or third-party trackers
- Phone numbers

### 4.8 Link previews

When you add a link to a post, your device asks our **link-preview proxy** to fetch the page's title
and image, so the linked website sees our server's address instead of yours or your friends'. To do
this, **the link address passes through our server in readable form for a moment.** Our proxy code
does not log or store it. [OWNER: confirm the hosting provider's request logs do not capture the URL,
e.g. by sending it in the request body.] The finished preview is encrypted with your post.

### 4.9 Push notifications (optional)

If you turn on **push notifications** for a device (Settings → Account), we store, for that device:

| Data | Why |
|---|---|
| The push **endpoint** your browser gives us (a web address at your browser maker's push service) and two encryption keys for it | To deliver notifications to that browser |
| A coarse device label such as "Chrome on Android" (not your full browser identifier) | So you can recognise your devices |
| When it was added and when a notification was last delivered | To clean up devices that stopped working |
| Which kinds of activity you want pushed (messages, comments, friend requests, …) | Your choices; they apply to all your devices |

**What a push says.** Only *who* did *what*: "dan sent you a message", "jessica commented on your
post", "dan sent a message to a group conversation". The name is the person's username (or the
directory name they chose to publish). **A push never contains the text of a message, post or
comment** — our servers can't read those, so they have nothing to put in it.

**Who carries it.** Web browsers deliver push notifications through their maker's push service:
**Google Firebase Cloud Messaging** (Chrome, Edge on Android, Samsung Internet, most Android
browsers), **Apple Push Notification service** (Safari, all iPhone/iPad browsers), **Mozilla
autopush** (Firefox) or **Microsoft Windows Push Notification Services** (Edge on Windows). Your
browser chooses the service, not us. Every push is **encrypted for your browser** (the Web Push
encryption standard, RFC 8291), so the push service can't read it; it does learn that *a*
notification was sent to your browser, when, and roughly how big it is, and it sees our server's
address.

**Turning it off.** Switch it off in Settings → Account (removes the device's record immediately),
log out on that device (the browser stops accepting our pushes and we delete the record the next time
the push service tells us so), or block notifications for Kithwall in your browser settings.

---

## 5. Why we use your data and our legal bases

| Purpose | Data used | Legal basis (GDPR / UK GDPR) | India DPDP |
|---|---|---|---|
| Create and run your account; sign you in; keep sessions | Account data, auth records, technical data | Contract (Art. 6(1)(b)) | Consent given at sign-up (s. 6); legitimate use where applicable (s. 7) |
| Store and deliver your encrypted content to the audiences you choose | Encrypted content, metadata | Contract | Consent |
| Send service emails: sign-up confirmation, password reset, security alerts, recovery-request alerts | Email address | Contract; legitimate interests in account security (Art. 6(1)(f)) | Consent |
| Send content-free notification emails ("You have a new notification") | Email address, notification records | Contract — you can turn these off in settings | Consent (withdrawable) |
| Send push notifications to devices where you turned them on ("dan sent you a message") | Push subscription, push preferences, notification and message metadata, the actor's username | Consent (Art. 6(1)(a)) — you turn it on per device and can turn it off at any time | Consent (withdrawable) |
| People search and friend suggestions | Username, display name, discoverable setting | Contract — only if you opt into the directory | Consent |
| Account recovery with trusted friends | Trusted-friend list, recovery requests | Contract — only if you set it up | Consent |
| Security, preventing spam and abuse (rate limits, captcha, auth logs, MFA) | Technical data, metadata | Legitimate interests in keeping the service and its users safe | Legitimate use (s. 7) / consent |
| Handling reports, enforcing our Terms and Community Standards, appeals | Reports (incl. disclosed content), metadata about the accounts involved | Legitimate interests in a safe service; legal obligation where law requires action (Art. 6(1)(c)) | Legitimate use (s. 7) |
| Reporting child sexual abuse material to the authorities | Reported content and related metadata | Legal obligation; legitimate interests and vital interests where no obligation applies | Legitimate use — compliance with law (s. 7) |
| Responding to valid legal requests and emergencies | Metadata, account data, reports | Legal obligation; vital interests (Art. 6(1)(d)) for emergencies | Legitimate use (s. 7) |
| Answering support requests | Your email and message | Contract; legitimate interests | Consent |
| Backups and disaster recovery | All stored data (ciphertext + metadata) | Legitimate interests in not losing your data | Legitimate use / consent |

**Sensitive information.** You may share things that reveal health, religion, politics, sexuality
or similar. When it is encrypted, we cannot read it. If you post it **Public**, you have chosen to
make it public. If it is **reported**, moderators see it only to handle the report.
[LAWYER: confirm GDPR Art. 9 condition for special-category data disclosed in reports.]

**No automated decisions with legal effects.** We use automated rate limits and a sign-up captcha to
stop abuse. These can temporarily stop an action (e.g. sending too many friend requests in a day),
but they do not make decisions about you that have legal or similarly significant effects.
Suspensions and bans are decided by a person.

**No profiling, no ads, no sale.** We do not use your data for advertising, profiling, or any
purpose you would not expect from a private social network. "Top News" ranking happens on **your**
device.

---

## 6. What we cannot access (end-to-end encryption)

| We cannot | Because |
|---|---|
| Read your encrypted posts, photos, messages, profile details, tags, check-ins, polls, notes, notification previews or game state | They are encrypted on your device with keys we never receive |
| Reset your password **and** keep your content | Your content keys are locked with your password or 24-word key, which we never see |
| Recover your content if you lose your password, recovery key and trusted-friend access | Nobody holds a spare key. This is by design |
| Hand your encrypted content to anyone, including the police | We don't have it in readable form |
| Search, scan, or analyse your encrypted content | Same reason |

**Honest limits.** End-to-end encryption on the web has limits we want you to know about:

- **Metadata** (section 4.3) is visible to us.
- **Public** content is not encrypted.
- **The app is delivered by our servers.** A malicious or compromised version of the app could
  steal keys. We reduce this risk by loading no third-party scripts and by publishing the source code:
  Kithwall is open source under the GNU Affero General Public License v3.0 (AGPL-3.0) at
  [github.com/443abdul/kithwall](https://github.com/443abdul/kithwall), and the app links to the exact
  version it is running, so anyone can review what it does.
- **Your device.** Malware or a browser extension with access to the page can read what you see.
- **Your friends** can screenshot or copy what you share with them.
- **No forward secrecy yet.** If someone later steals your main account key, they could decrypt
  your past content. Forward-secret messaging is planned for a future release.
- **Reports.** If someone who can see your content reports it, they disclose it to our moderators
  (section 8).

---

## 7. Who we share data with

We do not sell, rent or trade personal data. We share it only as follows.

### 7.1 Service providers (processors)

| Provider | What they do | Data they process | Location |
|---|---|---|---|
| **Supabase** [Supabase, Inc. — CONFIRM CONTRACTING ENTITY] | Database, authentication, file storage, realtime messaging, backups | Account data, ciphertext, metadata, auth and API logs (incl. IP addresses) | Database region **ap-south-1 (Mumbai, India)**; company in the USA; support/sub-processor access per their DPA |
| **Vercel** [Vercel Inc. — CONFIRM] | Hosting the web app, content delivery network, server routes (sign-up check, account deletion, link-preview proxy) | IP address, user agent, requested page address, link addresses passing through the preview proxy (not stored by our code) | Global edge network; company in the USA |
| **Spacemail by Spaceship** [Spaceship, Inc. — CONFIRM ENTITY AND DATA LOCATION] | Sending transactional email | Your email address, email delivery records; email text (which contains no post or message content) | [CONFIRM — e.g. USA] |

Each provider acts on our instructions under a data processing agreement: [Supabase DPA — date
signed], [Vercel DPA — date signed], [Spaceship DPA — date signed / CONFIRM ONE IS AVAILABLE].
Their own sub-processors are listed at [LINKS TO SUB-PROCESSOR LISTS].

**Browser push services.** If you turn on push notifications, each notification passes through the
push service your browser uses (Google FCM, Apple APNs, Mozilla autopush or Microsoft WNS — see
section 4.9). It is encrypted for your browser, so the service can't read it. These services are
part of your browser, operated by its maker under their own terms; we don't send them anything else.

We use **no** analytics, advertising, social-media, font, or captcha services from third parties.
Our captcha (ALTCHA) runs on our own servers.

### 7.2 Other users

Other users see what you share with them, and some things everyone signed in can see (your username,
public keys, and anything you make Public). Friends can see your friend list where the app shows it.
[OWNER: confirm whether friend lists are visible to friends at launch.]

### 7.3 Moderators

Moderators see reported items and related account metadata (section 8).

### 7.4 Legal requests and safety

We disclose data when the law requires it, or in an emergency involving a risk of death or serious
injury. We can only disclose what we have: mainly metadata and account data. See our
[Law Enforcement Guidelines](law-enforcement-guidelines.md). We report child sexual abuse material
as required by law.

### 7.5 Business changes

If Kithwall is transferred to a new operator (for example in a sale or reorganisation), your data
would transfer with it under this policy, and we would tell you in advance. Your encrypted content
would remain unreadable to the new operator too.

---

## 8. Reporting and moderation

- When you report an item, **your device sends our moderators the decrypted item and its content
  key.** Moderators use the key to confirm the report matches what is stored, so reports can't be
  faked.
- For a post, the content key also unlocks **comments on that post and photos attached to it**,
  because they are derived from or included in the post. Moderators are instructed to look only at
  what they need to decide the report (see our moderator policy).
- The person who posted the item is not told who reported it.
- Reports are kept for **1 year after they are resolved**, longer only where the law requires
  (for example, child sexual abuse material is preserved for authorities as the law requires).
- Moderators are specially appointed accounts. They cannot see any other content.

---

## 9. International transfers

Your data is stored in **India (Mumbai)** and processed by companies based in the **USA**, with
content delivery through Vercel's global network. [The operator is based in [OPERATOR COUNTRY].]

| From | To | Safeguard |
|---|---|---|
| EU/EEA | India (no EU adequacy decision) | EU Standard Contractual Clauses in [Supabase DPA] [CONFIRM] |
| EU/EEA | USA | EU–US Data Privacy Framework where the provider is certified [CONFIRM per provider]; otherwise Standard Contractual Clauses |
| UK | India / USA | UK International Data Transfer Addendum to the SCCs, or UK–US Data Bridge where applicable [CONFIRM] |
| Switzerland | India / USA | SCCs as adapted for Switzerland / Swiss–US DPF [CONFIRM] |
| India | Any country | Permitted under DPDP Act s. 16 unless the Central Government restricts transfers to that country |
| Other countries | India / USA | [LAWYER: confirm per launch market] |

You can ask us for a copy of the safeguards at [PRIVACY CONTACT EMAIL].

Because most of what we hold is ciphertext we cannot decrypt, the transferred content itself is
unreadable to us and our providers. Metadata and account data are readable.

---

## 10. How long we keep data

| Data | How long |
|---|---|
| Your content (encrypted or public) | Until you delete it. Deletion from the database is immediate; backup copies age out within **7 days** |
| Account data and key bundle | Until you delete your account |
| Metadata rows (friendships, memberships, likes, pokes, tags, votes, etc.) | Until you or the other person removes them, or until account deletion; backups age out within 7 days |
| Your whole account, when you delete it | Removed immediately. Your keys are destroyed, so encrypted copies left in backups can never be read. Unencrypted account data and metadata in backups age out within 7 days |
| Notifications | 90 days |
| Push subscriptions (per device) | Until you turn push off on that device, or the push service tells us the subscription has ended (e.g. after you log out or clear site data), or you delete your account |
| Push preferences | Until you delete your account |
| Recovery requests | 7 days after they close |
| Trusted-friend recovery shares | Until you change your trusted friends or delete your account |
| Reports and moderation decisions | 1 year after resolution (longer if legally required, e.g. child safety preservation) |
| Supabase authentication and API logs (incl. IP addresses) | 7 days (Supabase Pro plan) |
| Vercel request logs | 1 hour (Vercel Hobby plan runtime logs) |
| Spacemail delivery logs | [SPACEMAIL LOG RETENTION] |
| Link-preview requests | Not stored by us |
| Support emails | [SUPPORT EMAIL RETENTION, e.g. 2 years after the conversation ends] |
| Legal request records | [LEGAL REQUEST RECORD RETENTION, e.g. 3 years] |
| Ban records to stop re-registration (if used) | [OWNER DECISION: e.g. a one-way hash of the email address for N years] |
| Data on your device | Until you log out (logging out deletes the local key and cache) or clear your browser data |

**Copies on other people's devices.** People you shared with may keep copies (screenshots, their
own data exports, their device cache until they log out). Deleting your account cannot reach those.

---

## 11. Your rights

### 11.1 Rights you have

Depending on where you live, you have some or all of these rights:

| Right | How it works on Kithwall |
|---|---|
| **Access** — get a copy of your data | **Encrypted content:** use **Settings → Download Your Information**. Your device decrypts everything and builds a ZIP (HTML + JSON + photos). We can't do this for you, because we can't decrypt it. **Account data and metadata we hold:** email [PRIVACY CONTACT EMAIL] and we will send it to you |
| **Portability** | The export is in machine-readable JSON |
| **Correction** | Edit your profile and content in the app. Change your email in settings. For anything else, contact us |
| **Deletion** | Delete items in the app, or delete your account in **Settings → Account** (immediate). If you can no longer unlock your account (lost all keys), contact us: after confirming you control the email address, we will delete it for you. [OWNER: confirm this manual process exists before launch] |
| **Restriction / objection** | Contact us. You can object to processing based on legitimate interests; we will stop unless we have compelling grounds (e.g. security) |
| **Withdraw consent** | Turn off optional features (directory, trusted friends, email notifications, push notifications, online status) in settings, or delete your account. Withdrawal doesn't affect earlier processing |
| **Nominate someone (India)** | You may nominate a person to exercise your rights if you die or become incapable. Email the Grievance Officer with the nominee's name and email. Note: a nominee **cannot** read your encrypted content unless you have given them your recovery key |
| **Grievance redressal (India)** | See section 15 |
| **Complain to a regulator** | See 11.3 |

### 11.2 How to make a request

- Email **[PRIVACY CONTACT EMAIL]** from the email address on your account, or sign in and use
  [IN-APP REQUEST LOCATION, if any].
- We may ask you to confirm you control the account (for example, by replying from the account
  email or signing in). We will not ask for your password or recovery key — **never give these to
  anyone**.
- We reply within **one month** (GDPR/UK GDPR; extendable by two months for complex requests, and we
  will tell you why), **45 days** (California; extendable once by 45 days), and as required under
  Indian law. Requests are free unless clearly unfounded or excessive.
- You can use an authorised agent (California) or nominee (India); we will need proof of their
  authority.

### 11.3 Regulators

- EU/EEA: your local data protection authority ([LEAD SUPERVISORY AUTHORITY, if any]).
- UK: the Information Commissioner's Office (ico.org.uk).
- India: the Data Protection Board of India, after using our grievance process.
- California: the California Privacy Protection Agency.

We'd appreciate the chance to fix things first at [PRIVACY CONTACT EMAIL].

---

## 12. Children

- You must be **at least 16** to use Kithwall, or older if the law where you live requires it.
- **India:** the DPDP Act treats anyone under 18 as a child and requires verifiable parental consent.
  [OWNER DECISION: either require users in India to be 18+, or build verifiable parental consent
  before allowing 16–17-year-olds in India.]
- Kithwall is **not directed at children under 13**, and we do not knowingly collect personal data
  from them (US COPPA).
- If we learn that an account belongs to someone under the minimum age, we will delete it. Because
  we cannot read encrypted content, we rely on the age you confirm at sign-up and on reports. If you
  believe a child is using Kithwall, contact [PRIVACY CONTACT EMAIL].

---

## 13. Cookies and local storage

Kithwall uses **no advertising, analytics or tracking cookies** and no third-party cookies. We use
only storage that is **strictly necessary** to provide the service you asked for. Under EU/UK
e-privacy rules, strictly necessary storage does not need consent, so **we show no cookie banner**.

| Item | Where | Purpose | Lifetime |
|---|---|---|---|
| Sign-in session token (and refresh token) | Your browser (local storage and/or a first-party cookie) | Keeps you signed in | Until you log out; access tokens expire after 1 hour and are refreshed |
| Wrapped account key ("Keep me logged in" only) | IndexedDB | Lets the app unlock without re-typing your password. It is locked with a device key that the browser will not let be exported | Until you log out |
| Encrypted local cache | IndexedDB | Makes the app fast; content is encrypted with a key from your account | Until you log out |
| Service worker | Your browser | Receives push notifications (if you turn them on) and shows them. It **caches nothing** — no pages, no data | Until you clear site data |
| Push settings flags | Local storage | Whether you turned push on for this device, and when you dismissed the "turn on notifications" card | Until you clear site data |

The app also locks itself after 30 minutes of inactivity (you can change this), which wipes keys
from memory.

If we ever add non-essential cookies or storage, we will ask for your consent first.

---

## 14. Do Not Sell or Share (California and other US states)

- We **do not sell** personal information and **do not share** it for cross-context behavioural
  advertising. We have not done so in the past 12 months.
- We honour **Global Privacy Control** signals, though there is nothing to opt out of.
- We do not use or disclose sensitive personal information to infer characteristics about you.
- We will not treat you differently for exercising your privacy rights.

**California notice at collection — categories in the last 12 months:**

| CCPA category | Collected? | Example |
|---|---|---|
| Identifiers | Yes | Email, username, IP address (in provider logs) |
| Customer records (Cal. Civ. Code 1798.80) | Yes | Email address |
| Characteristics of protected classifications | Only if you post them; encrypted content is unreadable to us | — |
| Commercial information | No | — |
| Biometric information | No | — |
| Internet or network activity | Yes, limited | Sign-in logs, request logs, in-app metadata (section 4.3) |
| Geolocation | No precise location readable by us (check-ins are encrypted); approximate location may be inferable from IP address in provider logs | — |
| Audio, electronic, visual | Encrypted photos/content; unreadable to us | — |
| Professional / education information | Only if you post it; encrypted | — |
| Inferences / profiles | No | — |
| Sensitive personal information | Account login (email + authentication credential hash); content of messages is encrypted and unreadable to us | — |

Sources, purposes, retention and recipients are described in sections 4, 5, 7 and 10.

---

## 15. Grievance Officer (India) and complaints

**Grievance Officer:** [GRIEVANCE OFFICER NAME]
**Email:** [GRIEVANCE OFFICER EMAIL]
**Address:** [GRIEVANCE OFFICER ADDRESS]
**Hours:** [HOURS, e.g. Mon–Fri, 10:00–18:00 IST]

We will acknowledge your complaint within **24 hours** and resolve it within **15 days**
[LAWYER: confirm timelines under the IT Rules 2021 and DPDP Rules 2025]. If you are not satisfied,
you may complain to the Data Protection Board of India.

---

## 16. Security

- End-to-end encryption with audited libraries (XChaCha20-Poly1305, X25519, Ed25519, Argon2id).
- Your password and recovery key never leave your device.
- Every item is signed by its author, so the server can't alter or swap it without detection.
- Database access rules deny everything by default; each user can fetch only what they're allowed to.
- Strict browser security headers; no third-party scripts.
- Optional two-factor authentication (authenticator app), session list with "log out other
  sessions".
- Sensitive actions (deleting your account, changing recovery) require proof from your own device's
  keys, so a stolen email or session alone can't destroy your account.
- Recovery requests notify you and wait 24 hours before trusted friends can help.

No system is perfectly secure. Please use a strong unique password, turn on two-factor
authentication, and keep your 24-word recovery key somewhere safe offline.

---

## 17. Data breaches

If a breach affects your personal data, we will:

- notify the relevant data protection authority **within 72 hours** of becoming aware, where GDPR /
  UK GDPR requires it;
- notify the **Data Protection Board of India** and **each affected user in India** as the DPDP Act
  and Rules require, whatever the level of risk [LAWYER: confirm timelines, incl. any CERT-In
  reporting duty];
- tell affected users **without undue delay** where the breach is likely to put them at high risk,
  explaining what happened, what data was involved, and what to do;
- meet any US state breach-notification laws that apply.

Because content is end-to-end encrypted, a breach of our servers would expose **ciphertext,
metadata and account data**, not the readable content of your encrypted posts and messages. We will
say clearly which kinds of data were involved.

---

## 18. Changes to this policy

We will post changes here and update the date at the top. For material changes (for example,
switching on the Public audience, adding a new provider, or a new use of data), we will tell you in
the app and/or by email **at least [NOTICE PERIOD, e.g. 30] days** before they take effect, unless
the change is required urgently by law or for security. Earlier versions are available at
[POLICY ARCHIVE LINK].

---

## 19. Contact

- Privacy questions and requests: **[PRIVACY CONTACT EMAIL]**
- Grievance Officer (India): **[GRIEVANCE OFFICER EMAIL]**
- Post: [OPERATOR LEGAL NAME], [OPERATOR REGISTERED ADDRESS]

Related documents: [Terms of Service](terms-of-service.md) ·
[Community Standards](community-standards.md) ·
[Law Enforcement Guidelines](law-enforcement-guidelines.md)
