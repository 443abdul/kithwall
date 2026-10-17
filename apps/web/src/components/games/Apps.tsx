'use client';
// /apps — reference vApps, first-party only. There is no third-party app platform.
import Link from 'next/link';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import '@/styles/community.css';

const APPS: [string, string, string, string][] = [
  ['Kithville', 'game', '/games/kithville', 'Plant crops, harvest for coins, and help your neighbors. Your farm is encrypted — only you can see it.'],
  ['Questions', 'question', '/questions', 'Ask your friends anything. Votes are encrypted and tallied on your friends’ devices.'],
  ['Notes', 'note', '/notes', 'Write long-form posts for your friends.'],
  ['Events', 'event', '/events', 'Plan parties, invite friends and RSVP. Private events are encrypted to the guest list.'],
  ['Groups', 'group', '/groups', 'A private space for small groups: a shared wall, docs and members.'],
  ['Photos', 'photo', '/photos', 'Upload albums and tag your friends. Photos are encrypted on your device; location data is removed.'],
  ['Places', 'place', '/places', 'Check in and see where your friends have been. Location is only used when you press Check In.'],
];

export function Apps() {
  return (
    <AppPage active="apps" right={<RightBox title="Why No Other Apps?"><div style={{ lineHeight: '15px' }}>
      In 2010, apps you or your friends added could copy your profile, photos and friend list. Kithwall doesn&rsquo;t allow that, ever.</div></RightBox>}>
      <Title icon="app">Apps and Games</Title>
      <div className="list cm-apps">
        {APPS.map(([name, icon, href, desc]) => (
          <div className="it" key={name}>
            <Icon name={icon} />
            <div className="d"><Link className="big" href={href}>{name}</Link><br /><span className="gray">{desc}</span></div>
            <div className="x"><Link className="btn" href={href}>{icon === 'game' ? 'Play' : 'Go to App'}</Link></div>
          </div>
        ))}
      </div>
      <div className="cm-statement" role="note">
        <b><Icon name="shield" /> Kithwall has no third-party apps.</b>
        Everything here is built by Kithwall and runs on your device with your own keys. No outside developer, game company or
        quiz app can read your profile, your posts, your photos or your friends&rsquo; data — there is no app platform for them to use.
      </div>
    </AppPage>
  );
}
