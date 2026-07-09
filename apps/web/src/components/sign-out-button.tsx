'use client';

import { useTranslations } from 'next-intl';
import { signOut, useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export default function SignOutButton() {
  const t = useTranslations();
  const { data: session, status } = useSession();

  if (status === 'unauthenticated') {
    return null;
  }

  return (
    <Button
      variant="ghost"
      onClick={() => signOut({ callbackUrl: '/login' })}
      aria-label={t('common.logout')}
    >
      {t('common.logout')}
    </Button>
  );
}
