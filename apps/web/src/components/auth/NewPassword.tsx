'use client';
// "New password" + "Confirm" rows with the on-device strength meter. Read the values with
// readNewPassword(form) which validates them.
import { useState } from 'react';
import { StrengthMeter } from '@/components/auth/Splash';
import { passwordStrength } from '@/lib/auth/password';

export function NewPasswordRows({ inputs = [], prefix = 'np' }: { inputs?: string[]; prefix?: string }) {
  const [pw, setPw] = useState('');
  return (
    <>
      <tr><td className="l"><label htmlFor={`${prefix}-1`}>New password:</label></td>
        <td><input id={`${prefix}-1`} name="newpw" type="password" autoComplete="new-password" maxLength={256} value={pw} onChange={(e) => setPw(e.target.value)} required />
          <StrengthMeter pw={pw} inputs={inputs} /></td></tr>
      <tr><td className="l"><label htmlFor={`${prefix}-2`}>Confirm:</label></td>
        <td><input id={`${prefix}-2`} name="newpw2" type="password" autoComplete="new-password" maxLength={256} required /></td></tr>
    </>
  );
}

export function readNewPassword(f: FormData, inputs: string[] = []): string {
  const a = String(f.get('newpw') ?? ''), b = String(f.get('newpw2') ?? '');
  if (a !== b) throw new Error('The new passwords don\'t match.');
  const s = passwordStrength(a, inputs);
  if (!s.ok) throw new Error(`Please choose a stronger password. ${s.hint ?? ''}`.trim());
  return a;
}
