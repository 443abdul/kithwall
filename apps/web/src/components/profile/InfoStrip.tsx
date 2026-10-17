'use client';
// Profile info strip: "Works at · Studied at · Lives in · From · Born on" (reference infoStrip).
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { usePeopleVersion, people, type Person } from '@/lib/people';
import { birthdayText, relationship } from '@/lib/social/profile';

const search = (t: string) => <Link href={`/search?q=${encodeURIComponent(t)}`}>{t}</Link>;

export function RelationshipText({ person }: { person: Person }) {
  usePeopleVersion();
  const r = relationship(person);
  if (!r) return null;
  if (r.partner) {
    const p = people.person(r.partner);
    return <>{r.text} {p ? <Link href={`/${p.username}`}>{p.name}</Link> : '…'}</>;
  }
  return <>{r.text}</>;
}

export function InfoStrip({ person, isMe }: { person: Person | null; isMe: boolean }) {
  const info = person?.info;
  const parts: ReactNode[] = [];
  const job = info?.work?.[0];
  if (job?.employer) parts.push(job.position ? <>{job.position} at {search(job.employer)}</> : <>Works at {search(job.employer)}</>);
  const school = info?.education?.find((e) => e.kind === 'grad') ?? info?.education?.find((e) => e.kind === 'college') ?? info?.education?.[0];
  if (school?.school) {
    const future = school.year && Number(school.year) > new Date().getFullYear();
    parts.push(<>{future ? 'Studies' : 'Studied'} at {search(school.school)}</>);
  }
  if (info?.currentCity) parts.push(<>Lives in {search(info.currentCity)}</>);
  if (person && info?.relationship && info.relationship !== 'Single') parts.push(<RelationshipText person={person} />);
  if (info?.hometown) parts.push(<>From {search(info.hometown)}</>);
  const bday = birthdayText(info);
  if (bday) parts.push(<>Born on {bday.replace(/,\s*\d{4}$/, '')}</>);
  if (!parts.length) return isMe ? <Link href="/settings/profile?tab=edu">Add your work, school, and city</Link> : null;
  return (
    <>
      {parts.map((p, i) => <Fragment key={i}>{i > 0 && <span className="dt"> &middot; </span>}<span className="s">{p}</span></Fragment>)}
    </>
  );
}
