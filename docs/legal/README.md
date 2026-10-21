# Kithwall — Legal & Policy Drafts

> **Status: DRAFT v0.1 (2026-10-17). Not legal advice. A qualified lawyer must review all documents
> before public launch.** Written against [01-foundation](../01-foundation.md),
> [02-scope](../02-scope.md) and [03-spec](../03-spec.md). If the product changes, these must change
> too.

## 1. Documents

| File | Audience | Purpose |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | Public | GDPR / UK GDPR, India DPDP Act 2023, CCPA/CPRA-aware privacy notice: data categories, E2EE limits, legal bases, processors, transfers, retention, rights, children, cookies/storage, breach, grievance officer |
| [terms-of-service.md](terms-of-service.md) | Public | Eligibility, key responsibilities, narrow content licence, audiences, acceptable use, moderation and appeals, Kithville, IP, disclaimers, liability, termination, disputes |
| [community-standards.md](community-standards.md) | Public | Plain-language rules, how reporting works with E2EE, enforcement ladder, crisis resources |
| [moderator-policy.md](moderator-policy.md) | **Internal only** | Moderator appointment, access limits, report verification, decision log, CSAM procedure, legal requests, conflicts, appeals SLA |
| [law-enforcement-guidelines.md](law-enforcement-guidelines.md) | Public | What data exists and can/can't be produced, required process, preservation, emergencies, user notice, transparency |

Markers used in the drafts: `[PLACEHOLDER]` = fill in a fact · `[OWNER: …]` / `[OWNER DECISION: …]`
= product/business decision · `[LAWYER: …]` = needs legal advice · `[CONFIRM]` = check a vendor fact.

## 2. Placeholders to fill

**Identity & contacts**
- [ ] `[OPERATOR LEGAL NAME]`, legal form, `[OPERATOR REGISTERED ADDRESS]`, `[OPERATOR COUNTRY]`
- [ ] `[SERVICE DOMAIN]`
- [ ] Emails: `[CONTACT EMAIL]`, `[PRIVACY CONTACT EMAIL]`, `[LEGAL CONTACT EMAIL]`,
      `[ABUSE CONTACT EMAIL]`, `[SECURITY CONTACT EMAIL]`, `[LAW ENFORCEMENT CONTACT EMAIL]`,
      `[EMERGENCY CONTACT EMAIL]`, appeals route, `[DSA CONTACT EMAIL]`
- [ ] Grievance Officer (India): name, email, address, hours
- [ ] EU / UK Art. 27 representative (or reason not required); DPO (or "not appointed")
- [ ] Copyright agent (name, address, email)
- [ ] `[MODERATION LEAD / OWNER EMAIL]`, `[OUTSIDE COUNSEL]`, `[WELLBEING RESOURCE]`, moderator register location

**Dates & law**
- [ ] `[EFFECTIVE DATE]`, `[LAST UPDATED DATE]`, `[POLICY ARCHIVE LINK]`
- [ ] `[GOVERNING LAW / JURISDICTION]`, `[COURTS / VENUE]`, arbitration yes/no
- [ ] `[LEAD SUPERVISORY AUTHORITY]` (if any)
- [ ] `[NATIONAL AUTHORITY / HOTLINE]` for CSAM in the operator's country; Indian reporting route

**Vendors (confirm in each provider's dashboard/contract)**
- [ ] Contracting entities for Supabase, Vercel, Spaceship; DPAs signed and dated; sub-processor list links
- [ ] Transfer mechanisms per provider (SCCs, UK IDTA, DPF certification status)
- [ ] Spacemail data location
- [ ] `7 days (Supabase Pro plan)` (auth + API gateway logs, per plan), `1 hour (Vercel Hobby plan runtime logs)`,
      `[SPACEMAIL LOG RETENTION]`

**Numbers & periods**
- [ ] `[NOTICE PERIOD]` for policy/terms changes (suggest 30 days), `[SHUTDOWN NOTICE]` (suggest 60 days)
- [ ] `[LIABILITY CAP]`, `[APPEAL SLA]`, `[STRIKE EXPIRY]`, triage SLAs in the moderator policy
- [ ] `[SUPPORT EMAIL RETENTION]`, `[LEGAL REQUEST RECORD RETENTION]`, `[INACTIVITY PERIOD]` (or delete)
- [ ] Transparency report frequency and `[TRANSPARENCY REPORT URL]`
- [ ] Emergency-request response commitment (be realistic for a small team)

## 3. Owner decisions and product gaps found while drafting

These are places where the documents need a product change or a decision to be accurate.

1. **Age gate.** Sign-up has no age confirmation step in the spec. Add one (checkbox or date of birth).
2. **India age.** DPDP treats under-18s as children needing verifiable parental consent. Choose:
   18+ in India, or build parental consent.
3. **Deletion without keys.** Account deletion requires proof-of-key (spec §3.9). Someone who lost
   all keys can't delete themselves. Define a manual, email-verified deletion process (GDPR erasure).
4. **Display name.** `profiles.display_name` appears to be stored unencrypted. Confirm which name
   fields are plaintext and update privacy policy §4.1.
5. **Tag metadata.** `tag_notices` reveals *that* a user was tagged in a given photo even though the
   tag is encrypted. Disclosed in the policy; confirm this is acceptable.
6. **Reported post keys** unlock that post's comments and photos (spec §3.8). Disclosed; consider
   asking the reporter's device to disclose only the item's own data, or keep the disclosure.
7. **Link-preview URLs** pass through the proxy in plaintext. Make sure Vercel request logs don't
   capture them (send the URL in a POST body, not a query string).
8. **Vercel logs** record page paths such as `/alice`. Disclosed; consider shortest log retention.
9. **Removal vs appeals.** Decide whether moderator removal is a short soft-delete (so successful
   appeals can restore) or immediate hard-delete. Update retention tables either way.
10. **Ban records.** To stop re-registration you need to keep something (e.g. a hashed email).
    Decide and set retention.
11. **Open source / build hashes.** Decided: Kithwall is open source under AGPL-3.0-only and the privacy
    policy, footer and transparency page say so. **Make the repository public before these pages go live.**
    Published build hashes per release are still to do.
12. **Blocking.** Confirm exact block effects (messages, groups, events, visibility of username)
    and state them in the Community Standards.
13. **Moderation tooling** lands in R2 (spec). If launching with R1, decide how reports are handled
    until then.
14. **Friend list visibility** to friends at launch — confirm.
15. **Public switch-on.** Before enabling Public, update all five documents, give advance notice,
    and re-check the anon-access model (spec says nothing is readable without signing in).
16. **Encryption stance** (law-enforcement guidelines §7) — confirm you are prepared to stand by it.

## 4. Questions for your lawyer

**Structure & jurisdiction**
- [ ] Which entity should operate Kithwall, and where? What does that mean for governing law,
      consumer-protection carve-outs, and the liability cap?
- [ ] Is an EU and/or UK Art. 27 representative required given who we target?
- [ ] Is a DPO required (GDPR Art. 37)? Is a DPIA needed (new tech, social graph metadata at scale)?

**Privacy**
- [ ] Is ciphertext we can't decrypt still "personal data" for us? (Drafts assume yes, conservatively.)
- [ ] Are the legal bases right, especially consent vs. legitimate use under DPDP s. 7, and the
      Art. 9 condition for special-category data disclosed in reports?
- [ ] Transfers EU/UK → India (Supabase Mumbai) and → US: are the processors' SCCs/IDTA adequate?
      Do we need a transfer impact assessment?
- [ ] DPDP Rules 2025: consent-notice format, timelines for grievances, breach reporting to the
      Board and users, any minimum log-retention duty (and whether provider log retention meets it),
      phased commencement dates.
- [ ] India CERT-In directions (incident reporting in 6 hours, log retention): do they apply?
- [ ] Does CCPA/CPRA apply at all (thresholds)? Keep the California section anyway?
- [ ] Is "no cookie banner" correct for session token + IndexedDB + service worker in all launch markets?

**Platform regulation**
- [ ] EU Digital Services Act: are we an "online platform"? Small/micro-enterprise exemptions?
      Statement-of-reasons and transparency database duties?
- [ ] UK Online Safety Act: user-to-user service duties (illegal-content and children's risk
      assessments, Ofcom codes), and how they interact with E2EE.
- [ ] India IT Rules 2021: intermediary due diligence, grievance timelines, 72-hour information
      orders, 24-hour NCII removal; the "first originator" traceability rule if we ever reach the
      significant-social-media-intermediary threshold (5M Indian users) — E2EE conflict.
- [ ] US: 18 U.S.C. § 2258A CSAM reporting/preservation (applies if US provider?), TAKE IT DOWN Act
      48-hour NCII removal, Section 230, DMCA agent registration.
- [ ] Australia (under-16 social media minimum age) and US state minors' social media laws: in or
      out of launch markets? Do we need age assurance beyond self-declaration?
- [ ] Is holding preserved CSAM for authorities lawful in the operator's country, and how must it be stored?

**Terms**
- [ ] Is the "lost keys = no liability" clause enforceable as drafted, especially for EU/UK consumers?
- [ ] Liability cap, indemnity and disclaimers per market; arbitration/class waiver for US users?
- [ ] Trade dress / trademark risk from recreating a 2010-era social network's look, layout and
      feature names (Wall, News Feed, Poke, etc.); clearance for "Kithwall"/"Kithville".
- [ ] Virtual items clause: any gaming or consumer law issues if Kithville ever adds purchases?
- [ ] Law-enforcement guidelines: correct process mapping for the operator's jurisdiction, cross-border
      requests (MLAT, CLOUD Act, EU e-Evidence), gag orders, and whether the encryption stance in §7
      creates risk.
