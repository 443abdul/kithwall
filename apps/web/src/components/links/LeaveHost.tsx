'use client';
// Mounted once per V2Root. Renders nothing until a link is tapped; the sheet and the URL analyser (with the
// Public Suffix List) are a separate chunk loaded on first use.
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { closeLeave, registerLeaveHost, useActiveLeaveHost, useLeaveRequest } from '@/lib/links/leave';

const LeaveSheet = dynamic(() => import('./LeaveSheet'), { ssr: false });
let hostSeq = 0;

export function LeaveHost() {
  const [id] = useState(() => ++hostSeq);
  const active = useActiveLeaveHost();
  const req = useLeaveRequest();
  useEffect(() => registerLeaveHost(id), [id]);
  return req && active === id ? <LeaveSheet key={req.id} req={req} onClose={closeLeave} /> : null;
}
