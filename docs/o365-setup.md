# O365 Setup Documentation

**Reference:** ADR-0006 (O365 Access Model), Workplan 0008 T2

This guide walks you through setting up a multi-tenant Microsoft Entra (formerly Azure AD) application for Open-Migrate to access O365 resources (mail, calendar, contacts, OneDrive).

---

## Table of Contents

1. [Overview](#overview)
2. [App Registration Steps](#app-registration-steps)
3. [Consent Flow](#consent-flow)
4. [Secret/Certificate Handling](#secretcertificate-handling)
5. [Application Access Policy](#application-access-policy)
6. [Configuration](#configuration)
7. [Verification](#verification)

---

## Overview

Open-Migrate uses **one multi-tenant Entra application** to access O365 resources across different tenants. This approach:

- **Centralizes trust**: One app registration serves all tenants
- **Minimizes setup**: Admins only need to grant consent once per tenant
- **Follows least-privilege**: Permissions are scoped to only what's needed

### Access Model (per ADR-0006)

Two authentication paths are supported:

| Path | Use Case | Auth Type | Permissions |
|------|----------|-----------|-------------|
| **Managed Path** | Organization/SMB tenants | Application Credentials (client-credentials) | App permissions + Application Access Policy |
| **Self-Host Path** | Individual/family users | Delegated (user login) | Delegated permissions |

Both paths use the same app registration but different permission configurations.

### Least-Privilege Permission Sets

**Managed Path (Application Permissions):**
- `IMAP.AccessAsUser.All` - Access mail via IMAP with user context
- `Calendars.Read` - Read calendar events (Graph)
- `Contacts.Read` - Read contacts (Graph)
- `Files.Read.All` - Read OneDrive files (Graph)
- `offline_access` - Refresh token support

**Self-Host Path (Delegated Permissions):**
- `IMAP.AccessAsUser.All` - Access mail via IMAP with user context
- `Calendars.Read` - Read calendar events (Graph)
- `Contacts.Read` - Read contacts (Graph)
- `Files.Read.All` - Read OneDrive files (Graph)
- `offline_access` - Refresh token support

> **Note:** POP is intentionally NOT enabled. IMAP is the primary mail access method per ADR-0006.

---

## App Registration Steps

### Step 1: Navigate to Azure Portal

1. Go to [https://portal.azure.com](https://portal.azure.com)
2. Sign in with an account that has **Global Administrator** or **Application Administrator** permissions
3. Search for and select **Microsoft Entra ID** (formerly Azure Active Directory)

### Step 2: Register New Application

1. In the left menu, select **App registrations**
2. Click **+ New registration**
3. Fill in the form:
   - **Name**: `Open-Migrate` (or your organization's preferred name)
   - **Supported account types**: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**
   - **Redirect URI**: Not required for application credentials; for delegated flow, you can use `http://localhost` for testing
4. Click **Register**

### Step 3: Configure API Permissions

After registration, you'll be on the app's overview page. Navigate to **API permissions** in the left menu.

#### Add Application Permissions (for Managed Path)

1. Click **+ Add a permission**
2. Select **Microsoft Graph**
3. Select **Application permissions**
4. Add the following permissions:
   - `IMAP.AccessAsUser.All` (under Mail)
   - `Calendars.Read` (under Calendars)
   - `Contacts.Read` (under Contacts)
   - `Files.Read.All` (under Files)
   - `offline_access` (under Token Injection)
5. Click **Add permissions**

#### Add Delegated Permissions (for Self-Host Path)

1. Click **+ Add a permission** again
2. Select **Microsoft Graph**
3. Select **Delegated permissions**
4. Add the following permissions:
   - `IMAP.AccessAsUser.All` (under Mail)
   - `Calendars.Read` (under Calendars)
   - `Contacts.Read` (under Contacts)
   - `Files.Read.All` (under Files)
   - `offline_access` (under Token Injection)
5. Click **Add permissions**

### Step 4: Grant Admin Consent

For application permissions to work, an admin must grant consent:

1. Select all the application permissions you added (checkboxes)
2. Click **Grant admin consent for [Your Tenant]**
3. Confirm by clicking **Yes** in the dialog

> **Note:** This step is required only once per tenant. For multi-tenant deployment, each tenant admin will need to grant consent separately (see [Consent Flow](#consent-flow)).

### Step 5: Create Credentials

#### Option A: Client Secret (Recommended for Managed Path)

1. Navigate to **Certificates & secrets** in the left menu
2. Click **+ New client secret**
3. Fill in:
   - **Description**: `Open-Migrate Production` (or descriptive name)
   - **Expires**: Choose appropriate duration (12-24 months recommended)
4. Click **Add**
5. **Immediately copy the Value** - this is your `OAUTH2_CLIENT_SECRET`
   - ⚠️ **WARNING**: This value is shown only once. If lost, you must create a new secret.

#### Option B: Certificate (More Secure)

1. Navigate to **Certificates & secrets**
2. Click the **Certificates** tab
3. Click **+ Upload certificate**
4. Upload your certificate file (`.cer` format, public key only)
5. The certificate will appear in the list with its expiration date

For certificate-based auth, you'll need the private key locally for the application to use.

### Step 6: Record Application (Client) ID

1. Go back to **Overview** in the left menu
2. Copy the **Application (client) ID** - this is your `OAUTH2_CLIENT_ID`
3. Copy the **Directory (tenant) ID** - this is your `OAUTH2_TENANT_ID` (for single-tenant scenarios)

---

## Consent Flow

### Admin Consent for Tenant Onboarding

For the managed path (application permissions), each tenant's admin must grant consent before the app can access their resources.

#### Getting the Consent URL

Construct the consent URL with these parameters:

```
https://login.microsoftonline.com/{tenant}/adminconsent?
client_id={CLIENT_ID}&
redirect_uri={REDIRECT_URI}&
state={RANDOM_STATE}&
response_type=code
```

**Parameters:**
- `{tenant}`: Use `common` for multi-tenant or specific tenant ID
- `{CLIENT_ID}`: Your app's Application (client) ID
- `{REDIRECT_URI}`: Must match a configured redirect URI (e.g., `https://yourapp.com/auth/callback`)
- `{RANDOM_STATE}`: Generate a random string for CSRF protection

**Example consent URL:**
```
https://login.microsoftonline.com/common/adminconsent?client_id=12345678-1234-1234-1234-123456789abc&redirect_uri=https%3A%2F%2Fyourapp.com%2Fauth%2Fcallback&state=abc123xyz&response_type=code
```

#### Admin Consent Process

1. Send the consent URL to the tenant administrator
2. Admin clicks the link and signs in with their admin credentials
3. Admin reviews the permissions and clicks **Accept**
4. User is redirected to your `redirect_uri` with a `code` and `state` parameter
5. Your application can exchange the code for tokens (if implementing OAuth2 flow)

#### Verifying Consent Was Granted

**Method 1: Check in Azure Portal**

1. Go to **Microsoft Entra ID** → **App registrations** → Your app
2. Click **API permissions**
3. Look for a **Status** column showing "Granted" for each permission
4. Alternatively, check **Enterprise applications**:
   - Go to **Enterprise applications** in the left menu
   - Search for your app name
   - If it exists, consent has been granted

**Method 2: Test Token Request**

Attempt to acquire a token with the configured credentials. Success indicates consent is granted:

```bash
curl -X POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={CLIENT_ID}&client_secret={SECRET}&scope=https://graph.microsoft.com/.default&grant_type=client_credentials"
```

If you receive a valid access token, consent is working.

---

## Secret/Certificate Handling

### Security Rules

⚠️ **CRITICAL SECURITY REQUIREMENTS:**

1. **Never commit secrets to version control**
2. Store secrets only in:
   - Environment variables (`.env` files - never commit)
   - Secret management services (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault)
   - Kubernetes Secrets
   - Docker secrets
3. Never log secret values
4. Rotate secrets regularly (every 6-12 months)

### Client Secret Creation

When creating a client secret:

1. Choose appropriate expiration (12-24 months)
2. Use descriptive names to track multiple secrets
3. Create new secret before old one expires
4. Update application configuration before deleting old secret

### Certificate-Based Authentication

For higher security, use certificates instead of client secrets:

1. Generate a self-signed certificate or use a CA-issued certificate:
   ```bash
   # Generate private key and certificate
   openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
   ```

2. Upload the public certificate (`.cer`) to Azure Portal:
   - Go to **Certificates & secrets** → **Certificates** → **Upload**
   - Upload `cert.pem` (or convert to `.cer` format)

3. Configure your application to use the private key:
   ```bash
   OAUTH2_CLIENT_CERTIFICATE_PATH=/path/to/key.pem
   ```

### .env.example Entries

Create a `.env.example` file (this is safe to commit):

```env
# O365 OAuth2 Configuration
# Get these from Azure Portal → App registrations → Your app → Overview

# Tenant ID (Directory ID) - Use 'common' for multi-tenant
OAUTH2_TENANT_ID=your-tenant-id-here

# Application (Client) ID from Azure Portal
OAUTH2_CLIENT_ID=your-client-id-here

# Client Secret (DO NOT COMMIT - create in Certificates & secrets)
# Create in Azure Portal: App registrations → Your app → Certificates & secrets → New client secret
# NOTE: For production, use a secrets manager instead of .env files
OAUTH2_CLIENT_SECRET=your-client-secret-here

# Alternative: Certificate path (more secure than secrets)
# OAUTH2_CLIENT_CERTIFICATE_PATH=/path/to/private-key.pem

# For delegated flow (self-host path), user's refresh token
# This is obtained after user consent and initial auth
OAUTH2_REFRESH_TOKEN=your-refresh-token-here

# Graph API endpoint (usually不需要 change)
OAUTH2_GRAPH_URL=https://graph.microsoft.com

# OAuth2 Token Endpoint
OAUTH2_TOKEN_URL=https://login.microsoftonline.com/common/oauth2/v2.0/token
```

---

## Application Access Policy

Application Access Policies (per ADR-0006) restrict which mailboxes your app can access, implementing least-privilege access.

### What is an Application Access Policy?

An Application Access Policy scopes your app's access to specific mailboxes, even when using application permissions. This ensures your app can only access mailboxes you explicitly allow.

### Creating an App Access Policy (Exchange Admin Center)

1. Go to [https://admin.exchange.microsoft.com](https://admin.exchange.microsoft.com)
2. Navigate to **Permissions** → **App permissions**
3. Click **+ Add** to create a new policy
4. Fill in:
   - **Name**: `Open-Migrate Access Policy`
   - **App ID**: Paste your Application (client) ID
   - **Mailbox scope**: Select mailboxes or create a distribution group
5. Click **Save**

### Scoping to Specific Mailboxes

**Option 1: Individual Mailboxes**
- Add mailboxes one by one in the policy
- Best for small deployments

**Option 2: Distribution Group**
1. Create a distribution group in the Microsoft 365 Admin Center
2. Add all mailboxes that should be accessible to this group
3. In the App Access Policy, select the distribution group
4. Best for large deployments

### PowerShell Commands

Using Exchange Online PowerShell for more control:

```powershell
# Connect to Exchange Online
Connect-ExchangeOnline

# Create a new App Access Policy
New-ApplicationAccessPolicy -AppId <your-client-id> -PolicyScopeGroupId <distribution-group@domain.com> -AccessRight RestrictAccess -Label "Open-Migrate Access Policy"

# Verify the policy
Get-ApplicationAccessPolicy -AppId <your-client-id>

# Test the policy against a specific mailbox
Test-ApplicationAccessPolicy -AppId <your-client-id> -UserId <user@domain.com>

# Add mailboxes to a policy scope (using a security group)
Add-UnifiedGroupLinks -Identity "Open-Migrate-Access" -LinkType SamAccountName -Links "mailbox1"

# Remove a policy
Remove-ApplicationAccessPolicy -Identity <PolicyId>

# Disconnect when done
Disconnect-ExchangeOnline
```

### Policy Verification

After creating the policy, verify it's working:

```powershell
# Check if user is in scope
Test-ApplicationAccessPolicy -AppId <your-client-id> -UserId <user@domain.com>

# Expected output: Access is allowed (or denied if out of scope)
```

---

## Configuration

### Environment Variables

The following environment variables are required for Open-Migrate to connect to O365:

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `OAUTH2_TENANT_ID` | Yes | Azure AD tenant ID or 'common' | `common` or `12345678-1234-1234-1234-123456789abc` |
| `OAUTH2_CLIENT_ID` | Yes | Application (client) ID from Azure Portal | `12345678-1234-1234-1234-123456789abc` |
| `OAUTH2_CLIENT_SECRET` | Conditional | Client secret value (for client-credentials flow) | `abc123~XYZ.abc-123_xyz` |
| `OAUTH2_CLIENT_CERTIFICATE_PATH` | Conditional | Path to private key file (alternative to secret) | `/app/certs/private-key.pem` |
| `OAUTH2_REFRESH_TOKEN` | Conditional | User refresh token (for delegated flow) | `0.AXoA...` |
| `OAUTH2_GRAPH_URL` | No | Graph API endpoint (default: provided) | `https://graph.microsoft.com` |

### Configuration by Path

#### Managed Path (Client-Credentials Flow)

For organization/SMB tenants using application permissions:

```env
OAUTH2_TENANT_ID=tenant-id-or-common
OAUTH2_CLIENT_ID=your-client-id
OAUTH2_CLIENT_SECRET=your-client-secret
# No refresh token needed for client-credentials
```

#### Self-Host Path (Delegated Flow)

For individual users with delegated permissions:

```env
OAUTH2_TENANT_ID=common
OAUTH2_CLIENT_ID=your-client-id
# Client secret not needed for delegated flow with refresh token
OAUTH2_REFRESH_TOKEN=users-refresh-token
```

### .env.example File

Create a `.env.example` in your project root:

```env
# ===========================================
# O365 OAuth2 Configuration
# ===========================================
# Copy this file to .env and fill in your values
# NEVER commit .env to version control

# Azure AD Tenant ID (use 'common' for multi-tenant)
OAUTH2_TENANT_ID=

# Application (Client) ID from Azure Portal
OAUTH2_CLIENT_ID=

# Client Secret (for client-credentials flow)
# Get from Azure Portal: App registrations → Certificates & secrets
OAUTH2_CLIENT_SECRET=

# Alternative: Certificate path for authentication
OAUTH2_CLIENT_CERTIFICATE_PATH=

# Refresh Token (for delegated flow)
# Obtained after user consent and OAuth2 authorization
OAUTH2_REFRESH_TOKEN=

# Graph API Base URL (usually不需要 change)
OAUTH2_GRAPH_URL=https://graph.microsoft.com
```

---

## Verification

### Testing the Setup

#### Test 1: Client-Credentials Flow (Managed Path)

```bash
# Request access token
curl -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=https://graph.microsoft.com/.default&grant_type=client_credentials"
```

**Expected Response:**
```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "ext_expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc..."
}
```

#### Test 2: Graph API Access

```bash
# Test Graph API with the token
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2024-01-01T00:00:00&endDateTime=2024-12-31T23:59:59
```

**Expected Response:**
```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('user%40domain.com')/calendarView",
  "value": [
    {
      "id": "AAMkAGI...",
      "subject": "Meeting",
      "start": { "dateTime": "2024-01-15T10:00:00", "timeZone": "UTC" },
      "end": { "dateTime": "2024-01-15T11:00:00", "timeZone": "UTC" }
    }
  ]
}
```

#### Test 3: IMAP XOAUTH2 Authentication

Test IMAP access using the access token:

```bash
# Using curl to get IMAP token
curl -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=imap&grant_type=client_credentials"
```

Then use the token with imapsync or similar IMAP clients.

### Common Errors and Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid_client` | Wrong client ID or secret | Verify credentials in Azure Portal |
| `unauthorized_client` | Consent not granted | Admin must grant consent via consent URL |
| `insufficient_privileges` | Permissions not granted | Check API permissions in Azure Portal |
| `access_denied` | App Access Policy blocking | Verify mailbox is in policy scope |
| `429 Too Many Requests` | Rate limiting | Implement exponential backoff |
| `invalid_grant` | Refresh token expired | User must re-authenticate |
| `AADSTS50105` | Permission not consented | Request admin consent |
| `IMAP connection failed` | IMAP disabled in tenant | Enable IMAP in Exchange Admin Center |

### Troubleshooting Checklist

1. **Verify App Registration:**
   - [ ] App exists in Azure Portal
   - [ ] Correct tenant type (multitenant)
   - [ ] API permissions added correctly

2. **Verify Permissions:**
   - [ ] Admin consent granted (for application permissions)
   - [ ] Permissions show as "Granted" in Azure Portal

3. **Verify Credentials:**
   - [ ] Client ID matches Azure Portal
   - [ ] Client secret is valid (not expired)
   - [ ] No extra whitespace in environment variables

4. **Verify Access Policy:**
   - [ ] Policy created in Exchange Admin Center
   - [ ] Target mailboxes are in scope
   - [ ] Policy is enabled

5. **Verify Tenant Settings:**
   - [ ] IMAP enabled for mailboxes
   - [ ] No conditional access blocking the app
   - [ ] User/mailbox exists and is active

### Testing Token Response

A successful token response should include:

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "ext_expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6...",
  "scope": "Calendars.Read Contacts.Read Files.Read.All IMAP.AccessAsUser.All"
}
```

**Key fields to verify:**
- `token_type`: Should be "Bearer"
- `expires_in`: Token lifetime in seconds (typically 3599 = ~1 hour)
- `scope`: Should include all requested permissions
- `access_token`: Valid JWT token

### Token Decoding

To inspect token claims:

```bash
# Decode JWT token (base64 decode the middle section)
echo "eyJ0eXAiOiJKV1QiLCJhbGc..." | base64 -d | jq .
```

Expected claims:
- `scp` or `roles`: Should contain your requested permissions
- `aud`: Should be `https://graph.microsoft.com`
- `iss`: Should be `https://login.microsoftonline.com/{tenant}/v2.0`

---

## Quick Reference

### Permission Summary

| Permission | Type | Purpose | Flow |
|------------|------|---------|------|
| `IMAP.AccessAsUser.All` | Application/Delegated | Mail access via IMAP | Both |
| `Calendars.Read` | Application/Delegated | Read calendar events | Both |
| `Contacts.Read` | Application/Delegated | Read contacts | Both |
| `Files.Read.All` | Application/Delegated | Read OneDrive files | Both |
| `offline_access` | Delegated | Refresh token support | Delegated only |

### Flow Comparison

| Aspect | Managed Path | Self-Host Path |
|--------|--------------|----------------|
| Auth Type | Client Credentials | Delegated (Authorization Code) |
| User Interaction | None (admin consent only) | User login required |
| Token Type | Application token | User token |
| Refresh | Automatic (re-request) | Refresh token |
| Best For | Organization/SMB | Individual users |

### Links

- [Azure Portal](https://portal.azure.com)
- [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)
- [Exchange Admin Center](https://admin.exchange.microsoft.com)
- [Microsoft Identity Platform Documentation](https://docs.microsoft.com/en-us/azure/active-directory/develop/)
- [Graph API Permissions Reference](https://docs.microsoft.com/en-us/graph/permissions-reference)

---

## References

- **ADR-0006**: O365 Access Model - [docs/adr/0006-o365-access-model.md](./adr/0006-o365-access-model.md)
- **Workplan 0008**: O365 Graph Source - [docs/workplans/0008-o365-graph-source.md](./workplans/0008-o365-graph-source.md)
