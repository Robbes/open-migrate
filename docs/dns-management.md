# DNS Management Guide

This document provides comprehensive guidance for managing DNS records during the cutover process for OpenMigrate.

## Overview

DNS management is a critical component of the cutover process. Proper DNS configuration ensures that email, calendar, and contact services continue to work seamlessly after migration to the new target system.

## DNS Records Required

### 1. MX Records (Mail Exchange)

MX records direct email to your mail server.

**Configuration:**
```
Priority 10: mail.target-domain.com
Priority 20: mail2.target-domain.com (backup)
```

**Example:**
```
@    MX    10    mail.newmail.example.com
@    MX    20    mail2.newmail.example.com
```

**Important:**
- Set lower priority numbers for primary servers (10 is more important than 20)
- Always configure at least one backup MX server
- TTL should be set to at least 3600 (1 hour) before cutover

### 2. SPF Record (Sender Policy Framework)

SPF records prevent email spoofing by specifying which servers can send email on behalf of your domain.

**Configuration:**
```
v=spf1 include:_spf.target-provider.com ~all
```

**Example:**
```
@    TXT    "v=spf1 include:_spf.newmail.example.com ~all"
```

**Important:**
- Use `~all` (soft fail) during transition, switch to `-all` (hard fail) after verification
- Ensure no duplicate SPF records exist
- Test SPF with tools like MXToolbox before cutover

### 3. DKIM Records (DomainKeys Identified Mail)

DKIM adds digital signatures to emails, verifying the sender.

**Configuration:**
```
selector._domainkey    TXT    "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC..."
```

**Important:**
- Each DKIM key has a unique selector
- Generate DKIM keys in your target system
- DNS record name format: `{selector}._domainkey.{domain}`
- TTL should be at least 86400 (24 hours)

### 4. DMARC Record (Domain-based Message Authentication, Reporting, and Conformance)

DMARC tells receiving servers how to handle emails that fail SPF or DKIM checks.

**Configuration:**
```
_dmarc    TXT    "v=DMARC1; p=quarantine; sp=none; rua=mailto:dmarc-reports@your-domain.com"
```

**Policy Options:**
- `p=none`: Monitor only (recommended for initial setup)
- `p=quarantine`: Send suspicious emails to spam
- `p=reject`: Reject emails that fail authentication

**Important:**
- Start with `p=none` to monitor
- Gradually move to `p=quarantine` then `p=reject`
- Configure report destinations (rua) to receive DMARC reports

### 5. Autodiscover Records

Autodiscover helps email clients automatically configure connection settings.

**CNAME Configuration:**
```
autodiscover    CNAME    autodiscover.target-provider.com
```

**A Record Configuration:**
```
autodiscover    A    192.0.2.1
```

**Important:**
- CNAME is preferred over A record
- Ensure the target hostname is accessible
- Test autodiscover with various email clients

### 6. TXT Records for Domain Verification

Some providers require domain verification before enabling services.

**Example:**
```
@    TXT    "MS=ms12345678"  # For Microsoft 365 verification
```

## Pre-Cutover Checklist

### 1. DNS Audit (7 days before cutover)

- [ ] Document all existing DNS records
- [ ] Verify current email flow is working
- [ ] Check SPF, DKIM, and DMARC configurations
- [ ] Note current TTL values
- [ ] Identify DNS provider and access credentials

### 2. Prepare New DNS Records (3 days before cutover)

- [ ] Generate DKIM keys in target system
- [ ] Prepare all DNS record values
- [ ] Create DNS zone file for new configuration
- [ ] Test DNS records locally using `dig` or `nslookup`
- [ ] Verify SPF syntax with validation tools

### 3. Reduce TTL (24-48 hours before cutover)

**CRITICAL:** Reduce TTL values to minimize downtime during cutover.

```
Recommended TTL schedule:
- 7 days before: TTL 86400 (24 hours)
- 3 days before: TTL 43200 (12 hours)
- 1 day before: TTL 3600 (1 hour)
- Cutover day: TTL 300 (5 minutes) for MX records
```

**Warning:** Not reducing TTL can result in hours or days of email delivery issues.

## Cutover Process

### Step 1: Final Verification

Before changing DNS:
- [ ] Complete all data migration
- [ ] Run verification checks (score ≥ 95%)
- [ ] Confirm user accounts are ready
- [ ] Test email flow to new system with temporary records

### Step 2: Update DNS Records

Execute DNS changes in this order:

1. **MX Records** - Point to new mail servers
2. **SPF Record** - Update to include new servers
3. **DKIM Records** - Add new DKIM keys
4. **DMARC Record** - Update policy if needed
5. **Autodiscover** - Point to new system

**Example DNS Update:**
```
; MX Records
@    MX    10    mx1.newmail.example.com
@    MX    20    mx2.newmail.example.com

; SPF Record
@    TXT    "v=spf1 mx include:_spf.newmail.example.com ~all"

; DKIM Records
default._domainkey    TXT    "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD..."

; DMARC Record
_dmarc    TXT    "v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain.com"

; Autodiscover
autodiscover    CNAME    autodiscover.newmail.example.com
```

### Step 3: Verify Propagation

Use the DNS manager to verify propagation:

```bash
# Check MX record propagation
dig MX your-domain.com

# Check SPF record
dig TXT your-domain.com

# Check DKIM
dig TXT default._domainkey.your-domain.com

# Check DMARC
dig TXT _dmarc.your-domain.com
```

**Propagation Timeline:**
- 0-15 minutes: Some users will see new records
- 1-4 hours: Most users will see new records
- 24-48 hours: Full global propagation

### Step 4: Monitor Email Flow

After DNS update:
- [ ] Monitor email delivery logs
- [ ] Check spam folders for failed deliveries
- [ ] Verify DKIM signatures are valid
- [ ] Monitor DMARC reports
- [ ] Test with various email clients

## Post-Cutover Tasks

### 1. Increase TTL (After 48 hours)

Once confident in new setup, increase TTL values:

```
MX: 3600 (1 hour)
TXT: 3600 (1 hour)
CNAME: 3600 (1 hour)
```

### 2. Strengthen Security

After verification period:
- Change SPF from `~all` to `-all`
- Change DMARC from `p=none` to `p=quarantine` or `p=reject`
- Enable additional security features (TLS, MTA-STS)

### 3. Documentation

Update documentation with:
- New DNS configuration
- DKIM key rotation schedule
- DMARC reporting analysis
- Incident response procedures

## Troubleshooting

### Email Not Delivering

**Symptoms:** Emails bounce or go to spam

**Check:**
1. MX records are correctly configured
2. SPF record includes new servers
3. Reverse DNS (PTR) is set correctly
4. IP reputation of new servers

**Tools:**
- MXToolbox
- Mail-Tester
- Google Postmaster Tools

### DKIM Verification Failing

**Symptoms:** Emails fail DKIM checks

**Check:**
1. DKIM selector matches between DNS and email server
2. DKIM public key is correctly formatted
3. No character encoding issues in DNS record
4. DKIM key length is sufficient (2048 bits recommended)

### DMARC Reports Not Received

**Symptoms:** No DMARC reports at configured email address

**Check:**
1. Email address is valid and accessible
2. DMARC record syntax is correct
3. Reports are being sent (check with DMARC testing tools)
4. Consider using a DMARC analysis service (e.g., Postmark, Valimail)

## Rollback Procedures

If issues occur during cutover:

### Immediate Rollback

1. **Revert MX Records:**
   ```
   @    MX    10    old-mail.server.com
   @    MX    20    old-mail2.server.com
   ```

2. **Restore SPF Record:**
   ```
   @    TXT    "v=spf1 include:_spf.old-provider.com ~all"
   ```

3. **Wait for Propagation:**
   - Monitor DNS propagation
   - Allow 1-4 hours for full rollback

### Data Recovery

If emails were sent to new server:
1. Export emails from new system
2. Import to old system
3. Verify no data loss

## Best Practices

### DNS Management

- **Always reduce TTL before changes**
- **Keep backup of old DNS configuration**
- **Use DNS provider with API access for automation**
- **Implement DNS monitoring and alerting**
- **Test DNS changes in staging environment first**

### Security

- **Use DKIM with 2048-bit keys**
- **Enable DMARC with quarantine or reject policy**
- **Implement MTA-STS for TLS enforcement**
- **Regular DKIM key rotation (every 6-12 months)**

### Monitoring

- **Monitor DMARC reports daily during transition**
- **Set up alerts for delivery failures**
- **Track email deliverability metrics**
- **Monitor spam complaint rates**

## DNS Record Templates

### Complete DNS Zone Example

```dns
; MX Records
@    MX    10    mx1.newmail.example.com.
@    MX    20    mx2.newmail.example.com.

; SPF Record
@    TXT    "v=spf1 mx include:_spf.newmail.example.com ~all"

; DKIM Records
default._domainkey    TXT    "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD..."

; DMARC Record
_dmarc    TXT    "v=DMARC1; p=quarantine; sp=none; rua=mailto:dmarc-reports@your-domain.com; ruf=mailto:dmarc-forensics@your-domain.com"

; Autodiscover
autodiscover    CNAME    autodiscover.newmail.example.com.
autoconfig    CNAME    autoconfig.newmail.example.com.

; Mail server A records
mx1    A    192.0.2.10
mx2    A    192.0.2.11

; TLSA Record (optional, for DANE)
_25._tcp.mx1    TLSA    3 1 1 <certificate-hash>
```

## References

- [RFC 7505 - MX Null](https://tools.ietf.org/html/rfc7505)
- [RFC 7208 - SPF](https://tools.ietf.org/html/rfc7208)
- [RFC 6376 - DKIM](https://tools.ietf.org/html/rfc6376)
- [RFC 7489 - DMARC](https://tools.ietf.org/html/rfc7489)
- [Google Postmaster Tools](https://www.google.com/postmaster/)
- [MXToolbox](https://mxtoolbox.com/)

---

**Last Updated:** 2026-01-08  
**Version:** 1.0  
**Status:** Active
