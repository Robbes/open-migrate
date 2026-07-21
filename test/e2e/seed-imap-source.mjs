// Copyright 2026 The Open Migration Stack authors (Apache-2.0)
//
// Seed the SOURCE mailbox for the self-host restart-resume e2e (workplan 0010 T5).
// The restart-resume gate is only meaningful against a non-zero source, so this
// APPENDs N known messages to the source account's INBOX over IMAP — using
// imap-simple, the same client the app's IMAP connector uses.
//
// Config via env (all have dev defaults matching test/e2e/fixtures/…mapping.json
// and deploy/compose provisioning: source@dev.local / source_password):
//   SEED_IMAP_HOST      (default 127.0.0.1)
//   SEED_IMAP_PORT      (default 143)
//   SEED_IMAP_TLS       (default false; set "true" for 993)
//   SEED_IMAP_USER      (default source@dev.local)
//   SEED_IMAP_PASSWORD  (default source_password)
//   SEED_COUNT          (default 5) — number of messages to append
//
// Idempotent-ish: it appends SEED_COUNT messages with stable Message-IDs, so a
// re-run against a fresh mailbox produces the same corpus. Exits non-zero on any
// failure so the workflow stops before running the (now-meaningless) gate.

import imaps from 'imap-simple';

const host = process.env.SEED_IMAP_HOST || '127.0.0.1';
const port = Number(process.env.SEED_IMAP_PORT || '143');
const tls = (process.env.SEED_IMAP_TLS || 'false') === 'true';
const user = process.env.SEED_IMAP_USER || 'source@dev.local';
const password = process.env.SEED_IMAP_PASSWORD || 'source_password';
const count = Number(process.env.SEED_COUNT || '5');

function buildMessage(i) {
  // Stable, valid RFC 822 message. Fixed Message-ID + Date so repeated seeds of a
  // fresh mailbox yield the same natural keys (the ledger keys on Message-ID).
  const messageId = `<seed-${i}@dev.local>`;
  const date = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toUTCString();
  return [
    `From: source@dev.local`,
    `To: source@dev.local`,
    `Subject: Restart-resume seed message ${i}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Seed message ${i} for the self-host restart-resume idempotency gate (0010 T5).`,
    ``,
  ].join('\r\n');
}

async function main() {
  console.log(`[seed] connecting to imap://${user}@${host}:${port} (tls=${tls})`);
  const connection = await imaps.connect({
    imap: { user, password, host, port, tls, authTimeout: 15000 },
  });

  try {
    await connection.openBox('INBOX');
    for (let i = 1; i <= count; i++) {
      const msg = buildMessage(i);
      await new Promise((resolve, reject) => {
        connection.imap.append(msg, { mailbox: 'INBOX', flags: ['\\Seen'] }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      console.log(`[seed] appended message ${i}/${count}`);
    }
    console.log(`[seed] done — ${count} messages in ${user} INBOX`);
  } finally {
    connection.end();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err?.message || err);
  process.exit(1);
});
