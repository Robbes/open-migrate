// Copyright 2026 The Open Migration Stack authors (Apache-2.0)
//
// Seed the SOURCE Nextcloud account's default calendar + address book for the
// multi-domain self-host restart-resume e2e (workplan issue #114 follow-up: the
// original 0010 T5 gate only proved the mail/JMAP domain — see
// test/e2e/seed-imap-source.mjs for that half). PUTs N known calendar events into
// the source user's auto-provisioned 'personal' calendar and N known contacts into
// their auto-provisioned 'contacts' address book, over plain DAV PUT — the same
// protocol the app's own CalDAVSource/CarddavSource connectors use.
//
// Config via env (defaults match deploy/selfhost/setup-nextcloud-users.sh):
//   SEED_DAV_URL           Nextcloud base URL (default http://127.0.0.1:8082)
//   SEED_DAV_SOURCE_USER   source account userid (default e2e-source)
//   SEED_DAV_SOURCE_PASSWORD source account password (required)
//   SEED_COUNT             number of events AND contacts to seed (default 5)
//
// Idempotent-ish: fixed UIDs, so a re-run against a fresh account produces the same
// corpus. Exits non-zero on any failure so the workflow stops before the gate runs
// against a source that was never actually seeded.

const baseUrl = (process.env.SEED_DAV_URL || 'http://127.0.0.1:8082').replace(/\/$/, '');
const user = process.env.SEED_DAV_SOURCE_USER || 'e2e-source';
const password = process.env.SEED_DAV_SOURCE_PASSWORD;
const count = Number(process.env.SEED_COUNT || '5');

if (!password) {
  console.error('[seed-dav] SEED_DAV_SOURCE_PASSWORD is required');
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

function buildIcalendar(i) {
  const uid = `dav-seed-event-${i}@dev.local`;
  const day = String(10 + i).padStart(2, '0');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenMig//E2ESeed//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART:202601${day}T100000Z`,
    `DTEND:202601${day}T110000Z`,
    `SUMMARY:Restart-resume seed event ${i}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function buildVcard(i) {
  const uid = `dav-seed-contact-${i}@dev.local`;
  return [
    'BEGIN:VCARD',
    'VERSION:4.0',
    `UID:${uid}`,
    `FN:Restart Resume Seed Contact ${i}`,
    'END:VCARD',
  ].join('\r\n');
}

async function put(url, body, contentType) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader, 'Content-Type': contentType },
    body,
  });
  if (response.status !== 201 && response.status !== 204) {
    const text = await response.text().catch(() => '');
    throw new Error(`PUT ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function main() {
  console.log(`[seed-dav] seeding ${count} events + ${count} contacts for '${user}' at ${baseUrl}`);

  const calendarUrl = `${baseUrl}/remote.php/dav/calendars/${user}/personal`;
  const addressBookUrl = `${baseUrl}/remote.php/dav/addressbooks/users/${user}/contacts`;

  for (let i = 1; i <= count; i++) {
    const icalendar = buildIcalendar(i);
    await put(`${calendarUrl}/dav-seed-event-${i}@dev.local.ics`, icalendar, 'text/calendar; charset=utf-8');
    console.log(`[seed-dav] event ${i}/${count} PUT ok`);
  }

  for (let i = 1; i <= count; i++) {
    const vcard = buildVcard(i);
    await put(`${addressBookUrl}/dav-seed-contact-${i}@dev.local.vcf`, vcard, 'text/vcard; charset=utf-8');
    console.log(`[seed-dav] contact ${i}/${count} PUT ok`);
  }

  console.log(`[seed-dav] done — ${count} events in '${user}'/personal, ${count} contacts in '${user}'/contacts`);
}

main().catch((err) => {
  console.error('[seed-dav] FAILED:', err?.message || err);
  process.exit(1);
});
