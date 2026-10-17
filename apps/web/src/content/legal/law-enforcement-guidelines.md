# Kithwall Law Enforcement Guidelines

> **DRAFT v0.1 (2026-10-17) — not yet reviewed by a lawyer.**

**Effective date:** [EFFECTIVE DATE]

These guidelines are for law-enforcement agencies and government authorities seeking information
about Kithwall users. They are informational only and do not create rights for anyone. Users can
read them too: we want people to know exactly what we can and cannot hand over.

**Operator:** [OPERATOR LEGAL NAME], [OPERATOR REGISTERED ADDRESS]
**Requests to:** [LAW ENFORCEMENT CONTACT EMAIL] (requests are accepted only at this address or by
post; we do not accept requests from personal or non-official email domains)

---

## 1. Kithwall is end-to-end encrypted

Content that users share with friends, lists, groups, events and in messages is **encrypted on the
user's device**. Our servers store only ciphertext and **we do not have the keys**. We cannot
decrypt it, and no legal process can make us produce something we don't have.

What we **do** hold is **metadata** needed to run a social network, plus a small amount of account
and log data. Content a user marks **Public** (not available at launch) is unencrypted.

---

## 2. What data exists

### 2.1 Data we may be able to produce

| Category | Details | How long it exists |
|---|---|---|
| Basic subscriber information | Email address, username, display name (if stored unencrypted), account creation date, last sign-in time, whether MFA is on | Until account deletion |
| IP address records | From our hosting providers' authentication, API and request logs (sign-in, sign-up, password reset, API calls, page requests) | Short: [SUPABASE LOG RETENTION] (Supabase), [VERCEL LOG RETENTION] (Vercel). Our own app tables store no IP addresses |
| Public keys | Current keys and key-change history | Until account deletion |
| Social graph | Friendships and friend requests (with dates), blocks, membership of friend lists (not list names), group and event membership and roles, RSVPs, page likes, trusted-friend recovery contacts | Until removed by the user or account deletion |
| Activity metadata | Who posted to whose wall and when, item sizes; who commented/liked/voted on which item and when (not what they said or how they voted); pokes; that a user was tagged in an item | Until removed or account deletion |
| Messaging metadata | Which accounts are in a conversation; when each message was sent; size; read receipts | Until deleted or account deletion |
| Notification metadata | Recipient, type, triggering account, item reference, read/unread | 90 days |
| Recovery requests | Requests to restore an account via trusted friends, their timing and status | 7 days after they close |
| Reports | Where a user reported content to us: the reporter, the reported item/account, and the **content the reporter disclosed** | 1 year after resolution |
| Public content | Once the Public audience is enabled | Until deleted |
| Email delivery records | Held by our email provider (Spacemail by Spaceship) | [SPACEMAIL LOG RETENTION] |

### 2.2 Data we cannot produce

| Category | Why |
|---|---|
| Content of posts, comments, photos, messages, chats, profile details, tags, notes, polls and votes, check-ins, private groups/events, notification text, game state | End-to-end encrypted; we hold no keys |
| Passwords, private keys, recovery keys, recovery shares | Never sent to us, or only in encrypted form we cannot open |
| Location data | Check-ins are encrypted; we never collect device location; photo location data is stripped on the device before upload |
| Contact lists / address books | Never collected |
| Phone numbers, payment data, device identifiers | Never collected (browser user-agent strings appear only in short-lived hosting logs) |
| Deleted data | Account deletion is immediate; encrypted backup copies are unreadable once keys are destroyed, and all backups age out within 7 days |
| Real-time interception of content | We never hold plaintext |

**Account deletion.** Users can delete their accounts at any time and deletion is immediate. A
preservation request (section 4) preserves what exists at that moment; it cannot recover data
already deleted.

---

## 3. Legal process we require

We disclose user data only in response to valid legal process that applies to us, or under the
emergency procedure in section 5.

| Data requested | Minimum process [LAWYER: adapt to operator's jurisdiction] |
|---|---|
| Basic subscriber information, IP logs | Subpoena / production order or equivalent valid legal process |
| Other metadata (social graph, activity and messaging metadata, notifications, reports) | Court order or search warrant [LAWYER: e.g. US 18 U.S.C. § 2703(d) order / warrant; India CrPC/BNSS s. 94 notice or court order; EU/UK equivalents] |
| Content of reports or public content | Search warrant or equivalent |
| Prospective (real-time) metadata | Court order permitting it, where lawful [LAWYER: confirm] |

**Requests from outside [OPERATOR COUNTRY].** We may require foreign authorities to use a Mutual
Legal Assistance Treaty (MLAT), letter rogatory, or another mechanism recognised in
[OPERATOR COUNTRY] (e.g. the EU e-Evidence Regulation, CLOUD Act agreement), unless the law allows
us to respond directly. [LAWYER: confirm, including India IT Rules 2021 obligations to provide
information within 72 hours of a lawful order.]

**Every request must include:** the issuing authority and officer's name, badge/ID, official email
and phone; the legal basis; the specific Kithwall username(s) or account email(s); the specific
data sought; the date range; and the response deadline. We reject requests that are vague,
overbroad, or not legally valid, and we may challenge them in court.

---

## 4. Preservation requests

We will preserve a snapshot of the specified account data and metadata for **90 days** on receipt
of an official preservation request (e.g. under 18 U.S.C. § 2703(f) or an equivalent), pending
formal legal process, and extend once for a further 90 days on a renewed request. We cannot preserve
content we cannot decrypt in any useful form (we can preserve the ciphertext, but it remains
unreadable). Because provider logs are short-lived, please send preservation requests promptly.

---

## 5. Emergency requests

If you believe there is an emergency involving **imminent risk of death or serious physical
injury**, send an emergency request to [EMERGENCY CONTACT EMAIL] with "EMERGENCY" in the subject.
Explain the nature of the emergency, why it can't wait for normal legal process, and what specific
data would help. We review emergency requests [24/7 / within N hours — OWNER: set a realistic
commitment] and may voluntarily disclose the **minimum metadata** needed where the law permits. We
cannot provide encrypted content in an emergency either.

---

## 6. User notification

Our policy is to **notify users before disclosing their data**, giving them a chance to seek legal
advice or challenge the request. We will not notify when:

- we are legally prohibited from doing so (e.g. a non-disclosure order);
- notice would create a risk of death or serious physical injury, or of harm to a child; or
- the case involves child sexual exploitation and notice would hinder an investigation.

When a prohibition expires or the emergency has passed, we will notify the user. Requests that
include a non-disclosure order should state its legal basis and duration.

---

## 7. Our position on encryption

We will not build, and will legally challenge to the fullest extent the law allows, any demand to
weaken Kithwall's encryption, insert a "backdoor", or deliver a modified version of the app to a
targeted user. [OWNER/LAWYER: confirm this statement and its legal implications in each market,
including the UK Online Safety Act and India's IT Rules traceability provisions for significant
social media intermediaries.]

---

## 8. Child safety

We report apparent child sexual abuse material to NCMEC and/or
[NATIONAL AUTHORITY] as required by law, and preserve it as required. Because we cannot see
encrypted content, these reports arise from user reports, where the reporting user disclosed the
content to us. Agencies following up on a CyberTipline or other report from us may contact
[LAW ENFORCEMENT CONTACT EMAIL] referencing the report number.

---

## 9. Transparency reporting

We publish a transparency report every **[6 / 12] months** at [TRANSPARENCY REPORT URL], including
the number of government requests by country and type, the number of accounts affected, how often
we produced some data, emergency disclosures, preservation requests, and requests we challenged,
to the extent the law allows.

---

## 10. Cost and format

We may seek reimbursement of reasonable costs where the law permits. We produce records
electronically in a secure format, and can provide a records-authenticity certificate on request.

---

## 11. Other requests

- **Civil litigants:** we do not disclose user data in response to civil subpoenas except as
  required by law. Users can export their own data from their account.
- **Users seeking their own data:** see the [Privacy Policy](privacy-policy.md).
- **Content removal orders from authorities** (e.g. under the EU Digital Services Act or India's IT
  Rules): send to [LAW ENFORCEMENT CONTACT EMAIL]; we can act only on items we can identify. For
  encrypted items, we cannot confirm what they contain unless they have been reported to us.
