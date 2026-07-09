import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import AuthProvider from '@/components/auth-provider';
 
export async function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'nl' }];
}
 
export default async function LocaleLayout({
  children,
  params: { locale },
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  // Enable static rendering
  setRequestLocale(locale);

  // Ensure that the incoming `locale` is valid
  if (!['en', 'nl'].includes(locale)) {
    notFound();
  }
 
  const messages = await getMessages();
 
  return (
    <AuthProvider>
      <NextIntlClientProvider messages={messages}>
        {children}
      </NextIntlClientProvider>
    </AuthProvider>
  );
}
