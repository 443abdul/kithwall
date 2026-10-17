// Help Center content (reference vHelp, 2010 Help Center). Answers are Markdown rendered with
// components/auth/Markdown (no HTML). Each section has an anchor id used by links around the app.

export interface HelpSection { id: string; title: string; items: { q: string; a: string }[] }

export const HELP: HelpSection[] = [
  {
    id: 'basics', title: 'Getting Around',
    items: [
      { q: 'What are the three icons next to the logo?', a: 'Those are your jewels: **Friend Requests**, **Messages** and **Notifications**. When something new happens, a red number appears. Click a jewel to see what\'s new.' },
      { q: 'What\'s the difference between Top News and Most Recent?', a: '**Most Recent** shows everything from your friends, in order. **Top News** puts the stories your friends are talking about first. On Kithwall that ranking happens **on your own device** — there\'s no server algorithm deciding what you see.' },
      { q: 'What is a poke?', a: 'When the poke was invented, it was meant to be a feature without any specific purpose. It\'s still here. Poking someone back clears their poke. Use it wisely.' },
      { q: 'How do I find my friends?', a: 'Share an invite link from [Find Friends](/invite), or search for a friend\'s exact username. People only show up in name searches if they chose to be listed. We never ask for or upload your address book.' },
    ],
  },
  {
    id: 'encryption', title: 'Encryption & Privacy',
    items: [
      { q: 'What does "end-to-end encrypted" mean on Kithwall?', a: 'Your posts, photos, comments, messages and profile details are locked **on your device** before they\'re uploaded, with keys that only you and the people you share with have. Kithwall stores the locked copy but can\'t open it — and neither could anyone who stole our database.' },
      { q: 'What can Kithwall see?', a: 'Some things can\'t be hidden by encryption. We can see your email address and username; who is friends with whom; who messages whom and when; which groups and events you\'re in; that a like or comment happened (not what it says); roughly how big things are; and anything you post as **Public**. The full list is in your [Privacy Settings](/settings/privacy#encryption) and the [Privacy Policy](/legal/privacy).' },
      { q: 'What does the padlock mean? And the globe?', a: 'A padlock means the item is encrypted to the audience you chose (Friends, Only Me or a list). A globe and "Public — not encrypted" means anyone signed in can read it, including Kithwall. Kithwall is friends-only for now.' },
      { q: 'Why does it say "Waiting for someone\'s device to share this with you"?', a: 'Keys travel from device to device. When you become friends with someone, their app hands you their key the next time it\'s open. Until then you\'ll see this message. Nothing is lost; it fills in by itself.' },
      { q: 'Why is there no "Friends of Friends"?', a: 'To encrypt something for friends of friends we\'d have to hand keys to people you never chose. Use **Friends**, a **friend list**, or **Only Me** instead.' },
      { q: 'Why is there no "Change email"?', a: 'Your email is part of how your password unlocks your encryption keys on each device. Changing it safely needs a re-keying step we haven\'t built yet. For now, keep your email account secure — and turn on two-step verification.' },
    ],
  },
  {
    id: 'recovery', title: 'Passwords & Recovery',
    items: [
      { q: 'I forgot my password. Can Kithwall reset it?', a: 'We can send you a reset link, but the link alone **can\'t unlock your encrypted posts** — we don\'t have your keys. After opening the link you\'ll need your **24-word recovery key** or help from your **trusted friends**. [Start here](/recover).' },
      { q: 'What is the recovery key?', a: 'Twenty-four words shown once when you sign up. Together they can unlock your account if you forget your password. Write them on paper and keep them somewhere safe. You can make a new one any time in [Security & Recovery](/settings/security#recovery-key) — the old one then stops working.' },
      { q: 'What if I lost my password AND my recovery key?', a: 'If you set up trusted friends, they can help. If not, your encrypted posts, photos and messages can\'t be recovered by anyone. You can still delete the account and start over: because nobody can prove they own it any more, deletion happens after a **72-hour waiting period**, and logging in normally during that time cancels it.' },
      { q: 'Does "Keep me logged in" make me less safe?', a: 'It stores your keys on that device, locked by your browser in a way that can\'t be copied off it. Only use it on your own devices. You can turn it off from [This Device](/settings/security#device).' },
    ],
  },
  {
    id: 'trusted', title: 'Trusted Friends',
    items: [
      { q: 'How do trusted friends work?', a: 'You choose 3–5 friends and how many of them must help (2 or more). Your device splits your recovery key into pieces and gives each friend one piece, encrypted so only they can open it. **A single piece is useless.** Set it up in [Security & Recovery](/settings/security#trusted-setup).' },
      { q: 'What happens when I ask for help?', a: 'Your trusted friends are notified, and so are you — by email and on every device where you\'re logged in. Nobody can respond for a **waiting period** (normally 24 hours), so if it wasn\'t you there\'s time to cancel. Your screen shows **six words**; each friend sees the same six words and should only approve after hearing them from you by phone or in person.' },
      { q: 'A friend asked me for help. What should I do?', a: '**Call them or meet them.** Don\'t trust messages, email or texts — the person asking could be someone who broke into their email. Ask them to read you the six words on their screen. Approve only if every word matches. If anything feels wrong, do nothing: that\'s always safe.' },
    ],
  },
  {
    id: 'mfa', title: 'Two-Step Verification',
    items: [
      { q: 'How do I turn on two-step verification?', a: 'Go to [Security & Recovery](/settings/security#mfa) and choose "Set Up Authenticator App". After that, logging in on a new device needs your password and a 6-digit code from the app. Without the code, nobody can even download your encrypted data.' },
      { q: 'I lost the phone with my authenticator app.', a: 'Your recovery key can\'t switch two-step verification off — that\'s what keeps it strong. If you\'re still logged in somewhere, turn it off there and set it up again. Otherwise contact Kithwall support from the email on your account; we\'ll verify it\'s you before removing it, which takes time on purpose.' },
    ],
  },
  {
    id: 'safety', title: 'Safety, Reporting & Blocking',
    items: [
      { q: 'How do I report something?', a: 'Use **Report** on any post, photo, comment, message or profile. Because Kithwall can\'t read encrypted items, your device sends moderators **a copy of that one item and the key that opens it**. Moderators check the copy matches what\'s stored, so reports can\'t be faked. The person you report isn\'t told who reported them. See the [Community Standards](/legal/community).' },
      { q: 'What does blocking do?', a: 'Blocked people can\'t see your profile or anything you share, message you, poke you or send you friend requests. If you were friends, blocking also unfriends them and changes your keys so they can\'t read anything new. Manage blocks in [Privacy Settings](/settings/privacy#blocking).' },
      { q: 'Someone is in danger.', a: 'Contact your local emergency services first. Then report the content so our moderators can act.' },
    ],
  },
  {
    id: 'account', title: 'Your Account',
    items: [
      { q: 'How do I download my information?', a: 'Go to [Account Settings](/settings/account#download) and choose "Download Your Information". Everything is decrypted on your device and saved as a ZIP with your posts, photos, comments and messages.' },
      { q: 'How do I delete my account?', a: 'Go to [Account Settings](/settings/account#delete). Deletion is immediate and permanent: your device signs a one-time confirmation with your identity key, then everything is erased. Copies in backups age out within 7 days and can\'t be decrypted because your keys are gone.' },
      { q: 'Is Kithwall really free?', a: 'It\'s free, and always will be. There are no ads and no tracking — Kithwall never sells or shares your data for advertising.' },
    ],
  },
];
