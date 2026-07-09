'use client';

import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import SignOutButton from '@/components/sign-out-button';

export default function LocaleHomePage() {
  const t = useTranslations();
  const { status } = useSession();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-primary">{t('common.app_name')}</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
              {t('common.dashboard')}
            </Link>
            {status === 'authenticated' ? (
              <SignOutButton />
            ) : (
              <Link href="/login" className="text-muted-foreground hover:text-foreground">
                {t('common.login')}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-6">
            {t('common.app_name')}
          </h1>
          <p className="text-xl text-muted-foreground mb-8">
            Sovereign email migration from O365/Google to EU targets
          </p>
          <div className="flex gap-4 justify-center">
            <Link
              href="/dashboard"
              className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
            >
              {t('common.dashboard')}
            </Link>
            {status !== 'authenticated' && (
              <Link
                href="/login"
                className="px-6 py-3 border border-input rounded-lg font-medium hover:bg-accent transition-colors"
              >
                {t('common.login')}
              </Link>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
