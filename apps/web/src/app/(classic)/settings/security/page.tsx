'use client';
import { useEffect } from 'react';
import { AppPage } from '@/components/Shell';
import { SettingsTabs } from '@/components/auth/SettingsTabs';
import {
  DeviceSection, MfaSection, PasswordSection, RecoveryKeySection, SessionsSection, TrustedFriendsSection, TrusteePanel,
} from '@/components/auth/SecuritySections';

export default function SecuritySettingsPage() {
  useEffect(() => { document.title = 'Security & Recovery | Kithwall'; }, []);
  return (
    <AppPage bare>
      <div className="kw-page" style={{ maxWidth: 980, margin: '0 auto' }}>
        <SettingsTabs active="security" title="Security & Recovery" icon="shield" />
        <div className="kw-narrow" style={{ maxWidth: 720 }}>
          <PasswordSection />
          <MfaSection />
          <RecoveryKeySection />
          <TrustedFriendsSection />
          <TrusteePanel />
          <SessionsSection />
          <DeviceSection />
        </div>
      </div>
    </AppPage>
  );
}
