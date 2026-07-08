# Target Provider Documentation

This document describes the supported target providers for the IMAP/DAV target family, including configuration details, special-use folder handling, and known quirks.

## Overview

The IMAP/DAV target family supports migration to European sovereign platforms that use standard IMAP for email delivery. This includes:

- **Soverin** (Netherlands) - OX-based mail suite
- **openDesk** (Germany) - Open-Xchange + Nextcloud bundle
- **Stalwart** - Reference server for development and testing
- Other IMAP-compatible providers

---

## Soverin

### Provider Details

- **Country:** Netherlands
- **Type:** Managed SaaS
- **Protocol:** IMAP/SMTP, CalDAV, CardDAV
- **Base URL:** Varies by instance
- **IMAP Port:** 993 (TLS required)

### Configuration Example

```json
{
  "type": "imap-dav",
  "host": "imap.soverin.net",
  "port": 993,
  "user": "user@example.com",
  "auth": {
    "kind": "login",
    "passwordFromEnv": "SOVERIN_PASSWORD"
  }
}
```

### Special-Use Folders

Soverin follows RFC 6154 for special-use mailbox names:

| Purpose | Soverin Name | RFC 6154 Flag |
|---------|--------------|---------------|
| Sent | `Sent` | `\Sent` |
| Drafts | `Drafts` | `\Drafts` |
| Trash | `Trash` | `\Trash` |
| Junk/Spam | `Junk` | `\Junk` |
| Archive | `Archive` | `\Archive` |

### Known Quirks

1. **Folder Separator:** Uses `/` (forward slash)
2. **Namespace:** Full IMAP namespace support
3. **Flags:** Supports standard IMAP flags + custom flags
4. **Quota:** Check via `GETQUOTAROOT` command

### Testing Notes

- Test with real Soverin account before production use
- Verify special-use folder creation works correctly
- Confirm flag preservation (especially `\Seen`, `\Answered`, `\Flagged`)

---

## openDesk

### Provider Details

- **Country:** Germany (ZenDiS project)
- **Type:** Managed SaaS or self-hosted
- **Protocol:** IMAP/SMTP (Open-Xchange), CalDAV, CardDAV, WebDAV (Nextcloud)
- **Base URL:** Varies by instance
- **IMAP Port:** 993 (TLS required)

### Configuration Example

```json
{
  "type": "imap-dav",
  "host": "mail.opendesk.de",
  "port": 993,
  "user": "user@example.com",
  "auth": {
    "kind": "login",
    "passwordFromEnv": "OPENDESK_PASSWORD"
  }
}
```

### Special-Use Folders

openDesk (Open-Xchange) uses these folder names:

| Purpose | openDesk Name | Notes |
|---------|---------------|-------|
| Sent | `Sent Items` | Note: "Items" plural |
| Drafts | `Drafts` | Standard |
| Trash | `Deleted Items` | Note: "Items" plural |
| Junk | `Junk Email` | Note: Two words |
| Archive | `Archive` | Standard |

### Known Quirks

1. **Folder Names:** Open-Xchange uses "Items" plural for Sent and Trash
2. **Folder Separator:** Uses `/` (forward slash)
3. **Default Folders:** Pre-created on account setup
4. **Quota Display:** Available via `GETQUOTAROOT`

### Migration Notes

- **Proof Point:** Schleswig-Holstein migrated 40,000+ accounts and 100M+ mail/calendar items from Microsoft Exchange to Open-Xchange (late 2025)
- **Compatibility:** Full IMAP4rev1 support
- **Calendar/Contacts:** Use vdirsyncer for CalDAV/CardDAV sync (separate from IMAP email migration)

---

## Stalwart (Reference Server)

### Provider Details

- **Type:** Open-source reference server
- **Protocol:** JMAP + IMAP/DAV (dual protocol)
- **Use Case:** Local development, testing, self-hosting
- **IMAP Port:** 143 (STARTTLS) or 993 (TLS)

### Configuration Example (Development)

```json
{
  "type": "imap-dav",
  "host": "localhost",
  "port": 993,
  "user": "test@example.com",
  "auth": {
    "kind": "login",
    "passwordFromEnv": "STALWART_PASSWORD"
  }
}
```

### Special-Use Folders

Stalwart follows RFC 6154 strictly:

| Purpose | Stalwart Name | RFC 6154 Flag |
|---------|---------------|---------------|
| Sent | `Sent` | `\Sent` |
| Drafts | `Drafts` | `\Drafts` |
| Trash | `Trash` | `\Trash` |
| Junk | `Junk` | `\Junk` |
| Archive | `Archive` | `\Archive` |

### Setup for Testing

```bash
# Start Stalwart with IMAP support
docker run -d \
  --name stalwart-imap \
  -p 993:993 \
  -p 143:143 \
  -v stalwart-data:/data \
  stalwartlabs/stalwart:latest
```

See `docs/stalwart-integration-fix.md` for complete setup instructions.

---

## Other IMAP Providers

The IMAP/DAV target writer is designed to work with any standards-compliant IMAP server. Common providers include:

### Mailbox.org

- **IMAP Host:** `imap.mailbox.org`
- **Port:** 993 (TLS)
- **Special Folders:** Follows RFC 6154

### Mailfence

- **IMAP Host:** `imap.mailfence.com`
- **Port:** 993 (TLS)
- **Special Folders:** Follows RFC 6154

### Posteo

- **IMAP Host:** `imap.posteo.de`
- **Port:** 993 (TLS)
- **Special Folders:** Uses `Sent`, `Drafts`, `Trash`, `Junk`

### Infomaniak

- **IMAP Host:** `imap.infomaniak.com`
- **Port:** 993 (TLS)
- **Special Folders:** Follows RFC 6154

---

## Special-Use Folder Handling

### Automatic Detection

The `ImapDavMailTarget` automatically detects special-use folders using:

1. **RFC 6154 LIST EXTENSIONS:** Server-advertised special-use attributes
2. **Fallback Naming:** Common folder name patterns (Sent, Trash, etc.)

### Manual Configuration

If automatic detection fails, you can configure folder mappings in your migration config:

```json
{
  "type": "imap-dav",
  "host": "imap.example.com",
  "port": 993,
  "user": "user@example.com",
  "auth": { "kind": "login", "passwordFromEnv": "PASSWORD" },
  "folderMapping": {
    "sent": "Sent Items",
    "trash": "Deleted Items",
    "drafts": "Drafts",
    "junk": "Spam"
  }
}
```

---

## Authentication Methods

### Password Authentication (LOGIN)

Most common for IMAP/DAV targets:

```json
{
  "auth": {
    "kind": "login",
    "passwordFromEnv": "TARGET_PASSWORD"
  }
}
```

### OAuth2 Authentication (XOAUTH2)

Supported for providers that offer OAuth2:

```json
{
  "auth": {
    "kind": "xoauth2",
    "tokenFromEnv": "TARGET_OAUTH2_TOKEN"
  }
}
```

---

## Testing Checklist

Before migrating to a new provider, verify:

- [ ] IMAP connection successful (port 993 TLS)
- [ ] Authentication works with credentials
- [ ] Mailbox creation works
- [ ] Special-use folders are correctly identified
- [ ] Message upload (APPEND) works
- [ ] Message-ID lookup works (SEARCH HEADER)
- [ ] Flags are preserved (`\Seen`, `\Answered`, etc.)
- [ ] INTERNALDATE is preserved
- [ ] Idempotency works (re-upload same message → no duplicates)

---

## Troubleshooting

### Common Issues

**Issue:** "Mailbox not found" on upload
- **Solution:** Ensure `ensureMailbox()` is called before uploading messages

**Issue:** "Permission denied" on folder creation
- **Solution:** Check user has LITERAL+ permission or use CREATE command

**Issue:** Message uploaded but not visible
- **Solution:** Check if message was uploaded to wrong mailbox; verify folder separator

**Issue:** Flags not preserved
- **Solution:** Ensure flags are mapped correctly (`$seen` → `\Seen`)

### Debug Mode

Enable verbose logging for debugging:

```bash
export IMAP_DEBUG=1
pnpm worker --config mapping.json
```

---

## References

- [RFC 6154 - IMAP MAILBOX Creation](https://datatracker.ietf.org/doc/html/rfc6154)
- [RFC 3501 - IMAP4rev1](https://datatracker.ietf.org/doc/html/rfc3501)
- [Soverin Documentation](https://soverin.net/docs)
- [openDesk Documentation](https://opendesk.de/documentation)
- [Stalwart Documentation](https://stalwartlabs.org/documentation)

---

*This document was created by an AI agent (OpenHands) on behalf of the user.*
