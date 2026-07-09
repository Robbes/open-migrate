import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import SignOutButton from '@/components/sign-out-button';

export default function DashboardPage() {
  const t = useTranslations();
  const { data: session } = useSession();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-primary">{t('common.app_name')}</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/dashboard" className="text-foreground">
              {t('common.dashboard')}
            </Link>
            <Link href="/migrations" className="text-muted-foreground hover:text-foreground">
              {t('common.migrations')}
            </Link>
            <Link href="/settings" className="text-muted-foreground hover:text-foreground">
              {t('common.settings')}
            </Link>
            {session?.user?.email && (
              <span className="text-sm text-muted-foreground">
                {session.user.email}
              </span>
            )}
            <SignOutButton />
          </nav>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">{t('dashboard.welcome')}</h1>
          <p className="text-muted-foreground">
            Overview of your migration activities
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('migration.status_running')}
              </CardTitle>
              <CardDescription className="text-3xl font-bold">
                3
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Active migrations</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('migration.status_completed')}
              </CardTitle>
              <CardDescription className="text-3xl font-bold">
                12
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('migration.status_failed')}
              </CardTitle>
              <CardDescription className="text-3xl font-bold">
                1
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Requires attention</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('dashboard.total_items')}
              </CardTitle>
              <CardDescription className="text-3xl font-bold">
                2,847
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Total items migrated</p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Recent Migrations</h2>
            <Button asChild>
              <Link href="/en/migrations/new">
                {t('migration.new_migration')}
              </Link>
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">O365 → JMAP (family-mail)</p>
                    <p className="text-sm text-muted-foreground">Last run: 2 hours ago</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
                      {t('migration.status_running')}
                    </span>
                    <Link href="/en/migrations/1">
                      <Button variant="ghost" size="sm">
                        {t('dashboard.view_details')}
                      </Button>
                    </Link>
                  </div>
                </div>
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">Google → CalDAV (calendar)</p>
                    <p className="text-sm text-muted-foreground">Last run: 1 day ago</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800">
                      {t('migration.status_completed')}
                    </span>
                    <Link href="/en/migrations/2">
                      <Button variant="ghost" size="sm">
                        {t('dashboard.view_details')}
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
