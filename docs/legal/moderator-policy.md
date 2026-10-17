# Kithwall Moderator Policy

> **INTERNAL — not for publication.** DRAFT v0.1 (2026-10-17), not yet reviewed by a lawyer.
> Applies to everyone with moderator access, including the owner.

**Owner:** [OPERATOR LEGAL NAME] · **Policy contact:** [MODERATION LEAD / OWNER EMAIL]
**Effective date:** [EFFECTIVE DATE] · **Review:** at least every 12 months and after any incident.

---

## 1. Purpose and principles

Kithwall is end-to-end encrypted. Moderators are the **only** people who ever see a user's
encrypted content in readable form, and only because another user chose to report it. That is a
serious trust. This policy exists so that access stays narrow, decisions are consistent and
recorded, and child-safety and legal duties are met.

1. **Minimum necessary.** Look only at what you need to decide the report in front of you.
2. **Report-driven.** Never seek out content. No browsing, searching, or "checking up" on users.
3. **Consistent.** Apply the [Community Standards](community-standards.md) and the enforcement
   ladder, and write down why.
4. **Confidential.** What you see in a report stays in the moderation tool.
5. **Safe for you too.** You can step away from distressing material at any time.

---

## 2. Appointment and removal

| Step | Rule |
|---|---|
| Appointment | Only the owner ([OPERATOR LEGAL NAME / OWNER NAME]) appoints moderators, in writing (email or signed note), recorded in the moderator register (section 9) |
| Eligibility | Adult (18+); has read and signed this policy and a confidentiality undertaking; [background check — OWNER/LAWYER DECISION]; trained on sections 4–7 |
| Separate account | Each moderator uses a **dedicated moderator account**, not their personal Kithwall account. Moderator role is granted to that account only |
| Security | MFA (authenticator app) is **mandatory**; strong unique password; device with up-to-date OS and browser and **no browser extensions** with page access; full-disk encryption; screen lock |
| Location | Moderate only on a private screen, never in public places |
| Removal | The owner removes moderator role immediately on resignation, misconduct, a suspected account compromise, or 90 days of inactivity. Log the date and reason |
| Review | The owner reviews the list of moderator accounts every [3] months |

The owner may act as a moderator but is subject to this policy in full.

---

## 3. What moderators can and cannot access

### 3.1 Can access

- Rows in the **reports** table: reporter, target (item or account), reason, the **decrypted item
  and content key disclosed by the reporter**, status.
- Metadata needed to decide a report about an account, as provided by the moderation tool (e.g.
  account age, number of prior reports and decisions, whether the reporter and reported user are
  friends). [OWNER: define exactly what the moderation tool shows.]
- Public content (only once the Public audience is enabled).
- The decision log.

### 3.2 Cannot access (by design)

- Any encrypted content that has not been reported. Moderators have no keys for it; the database
  rules do not grant moderator accounts access to other users' content rows.
- Users' private keys, passwords, recovery keys or recovery shares.
- Raw database, storage or log access. That is limited to the owner, for operations only, under
  section 3.4.

### 3.3 The content-key caveat

A reported **post's** content key also derives the keys for **its comments** and contains the
**file keys of attached photos**. That means a moderator can technically decrypt the post's
comments and photos. Rules:

- Open comments or photos **only** if the report concerns them or they are needed to understand
  the reported item (e.g. the reported comment's context).
- Record in the decision log that you viewed them and why.
- Reported **messages** disclose only that message. Do **not** ask the reporter for more of the
  conversation unless needed; if needed, ask them to report the specific additional messages.

### 3.4 Owner operational access

The owner holds the Supabase and Vercel admin credentials and the server secret key. These are
used only for operating the Service, account deletions users cannot complete themselves, legal
requests (section 7), and enforcement actions the moderation tool can't perform. **Never** use
them to look at metadata about a user out of curiosity or for any personal reason. Log every
access made for a user-specific reason in the decision log or legal request log.

---

## 4. Handling a report

### 4.1 Triage (priority order)

| Priority | Category | Target first response |
|---|---|---|
| P0 | Child sexual abuse material (CSAM), grooming, sextortion of a minor; imminent threat to life; suicide risk | **As soon as seen; within [4] hours** |
| P1 | Non-consensual intimate imagery (NCII); credible violent threats; terrorism | Within [24] hours (NCII removal within the legal deadline: [24h India / 48h US — LAWYER CONFIRM]) |
| P2 | Harassment, hate, impersonation, doxxing, illegal goods | Within [48] hours |
| P3 | Spam, minor violations, everything else | Within [7] days |

### 4.2 Verify the report

Before acting, confirm the report is genuine:

1. The **content key decrypts the stored ciphertext** for the reported item (the moderation tool
   does this automatically). If it fails, the report is invalid; record and close.
2. The decrypted content **matches** what the reporter disclosed.
3. The **author signature** verifies against the author's public key at the time of posting, so the
   item really came from that account.
4. Consider context: is it a joke between friends, a quote, news reporting, condemnation?
5. Check the **reporter's history** for abuse of reporting (many rejected reports against the same
   person).

### 4.3 Decide

- Identify the specific Community Standards rule.
- Choose the action using the enforcement ladder (Community Standards section 3) and the account's
  history.
- If unsure, escalate to the owner. Never guess on P0.

### 4.4 Act and notify

- Carry out the action (remove item, limit, suspend, ban).
- Send the affected user a **statement of reasons**: action, rule, whether it came from a report,
  whether automated means were used (normally no), and how to appeal. Do **not** reveal the
  reporter. Skip or delay notice only where it would endanger someone, tip off a suspect in a
  child-safety or law-enforcement matter, or the law forbids it; log why.
- Tell the reporter the outcome.

### 4.5 What never to do

- Never copy, screenshot, download, forward or discuss reported content outside the moderation
  tool, except as section 6 requires for CSAM reporting.
- Never use your personal account or device storage for moderation material.
- Never contact the reported user or reporter outside official notices.
- Never moderate in a case where you have a conflict of interest (section 8).

---

## 5. Decision log

Every report and every enforcement or legal action is logged. Fields:

| Field | Notes |
|---|---|
| Log ID, report ID | |
| Date/time received, triaged, decided | For SLA tracking |
| Moderator account ID | |
| Category and priority | |
| Verification result | Key decrypts? Content matches? Signature valid? |
| Extra items viewed | e.g. "viewed 3 comments on reported post for context" |
| Rule applied | Community Standards section number |
| Action taken | Ladder step, duration |
| Reasoning | 1–3 sentences |
| Notices sent | To user / reporter; or why not |
| External reports | NCMEC report ID / authority reference |
| Appeal | Date, reviewer, outcome |

**Retention:** same as reports — **1 year after resolution**, unless on legal hold or part of a
CSAM report (then as required by law). The log must not contain copies of reported content beyond
what is in the report row.

---

## 6. CSAM procedure

**Do not** view more than is needed to identify the material. If you are unsure whether a minor is
involved, treat it as CSAM.

1. **Stop and contain.** Do not download, screenshot, copy, forward or show the material to anyone
   except as below. Do not try to investigate the user yourself.
2. **Remove** the item from the Service (delete the stored item) and **suspend** the account
   immediately, without notifying the user (notice could tip them off).
3. **Preserve.** Mark the report, the disclosed content and key, the encrypted original, and the
   relevant account metadata and logs as **legal hold** in a restricted area accessible only to the
   owner. Preserve for at least **1 year** (US 18 U.S.C. § 2258A(h) as amended) or longer if the
   authorities request or the law requires. [LAWYER: confirm preservation location and method
   comply with local law on possession of CSAM.]
4. **Report** as soon as reasonably possible:
   - **NCMEC CyberTipline** (US law requires US providers to report; non-US providers may report
     voluntarily) [LAWYER: confirm obligation for operator's location];
   - **[NATIONAL AUTHORITY / HOTLINE for operator country]**;
   - **India:** [e.g. National Cybercrime Reporting Portal (cybercrime.gov.in) / local police, as
     required by POCSO Act s. 19 and IT Rules — LAWYER CONFIRM].
   Include the content, account identifiers, timestamps and relevant IP data from provider logs, as
   the reporting form asks. Record the report reference in the decision log.
5. **Ban** the account permanently. Remove related accounts only after the authorities have had the
   chance to request preservation, or as they direct.
6. **Never redistribute.** After the preservation period ends, securely delete the material and log
   the deletion.
7. **Look after yourself.** Take a break. The owner will arrange support ([WELLBEING RESOURCE]).
   Moderators may decline P0 work.

---

## 7. Law-enforcement and legal requests

All legal requests go to the **owner** (or designated legal contact). Moderators must not respond
to or act on them. Follow the public [Law Enforcement Guidelines](law-enforcement-guidelines.md).

### 7.1 What data exists

| We can produce (if it exists and a valid request covers it) | We cannot produce |
|---|---|
| Email address, username, display name (if stored unencrypted), account creation date, last sign-in, MFA status | Encrypted content: posts, comments, photos, messages, profile details, tags' content, check-ins, polls, notes, notification previews, game state |
| Public keys and key-change history | Private keys, passwords, recovery keys, recovery shares (all encrypted to keys we don't hold) |
| Friendships and friend requests (with dates), blocks | Location from check-ins (encrypted) or device location (never collected) |
| Conversation membership, message timestamps, sizes, read receipts | Content of messages in real time (we never hold plaintext) |
| Post/comment/like/poke/tag-notice/poll-vote/RSVP rows and timestamps | Address books (never collected) |
| Group/event membership and roles, page likes | Deleted data after it has aged out of backups (7 days) |
| Notification metadata (90 days), recovery requests (7 days after closing) | |
| IP addresses from Supabase auth/API logs and Vercel request logs, within their short retention | |
| Public content (once Public is enabled) | |
| **Reports**, including any content disclosed by the reporter, for 1 year after resolution | |

### 7.2 Handling steps

1. **Log** the request (date, agency, officer, legal instrument, scope, deadline).
2. **Verify authenticity**: contact the agency through an independently found number or address;
   check the official domain.
3. **Check legal validity**: correct legal process for the data type and our jurisdiction
   (section 3 of the public guidelines); specific accounts identified; not overbroad. If unsure,
   consult [OUTSIDE COUNSEL].
4. **Preservation requests**: snapshot the specified metadata and keep it for 90 days (one
   extension on request), pending formal process.
5. **Emergency requests**: if the agency states facts showing an imminent risk of death or serious
   physical injury, the owner may disclose the minimum metadata needed without formal process,
   documenting the justification. Ask for the follow-up legal process.
6. **Notify the user** before disclosure unless prohibited by law/court order, or notice would
   create a risk to life, a child, or an investigation. Record the reason for any delay and set a
   reminder to notify when the restriction ends.
7. **Produce** the minimum data responsive to the request, in a secure format, with a records
   certificate if needed.
8. **Push back** on requests to alter our software to weaken encryption or to target a user with a
   modified app. Escalate immediately to counsel. [OWNER/LAWYER: confirm policy position.]
9. **Record** the outcome for the transparency report.

### 7.3 Transparency report

The owner publishes a transparency report every **[6 / 12] months** at [TRANSPARENCY REPORT URL]
covering: number of reports by category and actions taken; appeals and reversals; median response
times; government requests by country and type, accounts affected, and % where some data was
produced; emergency disclosures; preservation requests; CSAM reports made to NCMEC/authorities;
removal orders from authorities (DSA/IT Rules); and requests we challenged. [LAWYER: confirm
whether national-security request reporting is restricted in the operator's jurisdiction.]

---

## 8. Conflicts of interest

- Do **not** handle a report if you know the reporter or the reported user personally, are in a
  group or event connected to the dispute, or have any other reason you might not be impartial.
  Pass it to another moderator or the owner and note the recusal in the log.
- Do not handle an appeal of your own decision.
- Moderators may not accept gifts, payment or favours from users.
- Moderators may not use what they learn for any purpose other than moderation, during or after
  their role.

---

## 9. Moderator register

The owner keeps a register (outside Kithwall, e.g. [LOCATION]) with: moderator name, moderator
account ID, date appointed, date policy and confidentiality undertaking signed, training completed,
MFA verified, date removed and reason.

---

## 10. Appeals

| Step | SLA |
|---|---|
| Acknowledge appeal | Within **24 hours** [aligns with India IT Rules acknowledgement] |
| Decide appeal | Within **[7] days**; complaints under India's IT Rules resolved within **15 days**; NCII complaints within the legal deadline |
| Reviewer | A different moderator from the original decision-maker; if none is available, the owner |
| Possible outcomes | Upheld · reduced · reversed (restore item where technically possible, lift restriction, clear the strike) |
| Notice | Outcome and reasons sent to the user (and to the reporter, if they appealed a decision not to act) |

**Restoring removed encrypted items:** once a stored item is deleted, it cannot be restored from the
moderation tool (we keep no readable copy). [OWNER: decide whether removal is a soft-delete for an
appeal window, e.g. hide for 14 days then hard-delete, and update this policy and the Privacy
Policy retention table.]

Appeals must be lodged within **6 months** of the decision. Track appeal outcomes for consistency
and training.

---

## 11. Breaches of this policy

Misuse of moderator access (looking at content without a report, sharing content, acting with a
conflict) leads to immediate removal of access and may be a personal data breach that must be
assessed under the Privacy Policy's breach procedure (72-hour clock under GDPR). Report any
suspected misuse or account compromise to the owner immediately.

---

**Acknowledgement**

I have read and will follow this policy.

Name: ______________________ Moderator account ID: __________ Date: __________
