# The first live run — who does what

Everything in workplans 0093, 0094 and ADR-0042 is proven against stubs,
PGlite and Testcontainers. **Nothing has met a real identity provider, a real
mail server, or a real domain.** This is the plan for changing that, split by who
can actually do each part.

The split is not arbitrary. Some of this needs a machine, a credential, or a DNS
record — things an agent cannot and should not hold. The rest is code, and
leaving it until the live run is how a live run becomes an afternoon of
debugging instead of a checklist.

---

## Do these before the live run — **Claude**

Each removes a way the live run can fail for a reason that has nothing to do with
what is being tested.

| | Why it has to be before, not during |
|---|---|
| **Self-registration in `setup-zitadel.sh`** ([0095 T0](./workplans/0095-telling-somebody-they-are-in.md)) | Blocked on your decision, and it is the one that stops the run dead: a granted person with no way to create an account cannot sign in, and no amount of debugging on the day will fix a setting that was never scripted. |
| **The access-granted email** (0095 T1–T3) | Otherwise the live run proves a flow that ends with "and now Rob sends an email by hand", which is not the flow. |
| **A rehearsal script** | One command that knocks, grants, and asserts the invitation bound — against the local stack, with a stub issuer. It cannot prove Zitadel works. It can prove that *everything either side of Zitadel* works, so the live run is testing one thing. |
| **`/api/ready` reachable through the proxy** | It is mounted at `/ready` and `/api/ready`, but no reverse-proxy config has been exercised. If the status page cannot reach it, its first impression is four red lights that mean nothing. |

## Do these on the day — **Rob**

In order. Each has a check, because "it seemed to work" is how the next one fails.

### 1. Decide the addresses, once

`ZITADEL_EXTERNALDOMAIN` is stamped into **every token's `iss`**, and the API
compares it byte for byte. Changing it later invalidates every live session — it
is not a setting you can tidy up afterwards.

Decide all of them together: `app.` (WEB_URL), the API address, `id.` (the
issuer), `status.`, and the address mail is sent **from**. Write them into
`deploy/compose/.env` before anything starts.

> **Check:** `grep -E 'WEB_URL|API_URL|ZITADEL_EXTERNALDOMAIN' deploy/compose/.env` — no `localhost` anywhere.

### 2. DNS and certificates

A and AAAA records for each name, and whatever your reverse proxy needs to get
certificates. The issuer will not serve a usable discovery document over a name
it does not think it has.

> **Check:** `curl -fsS https://id.<domain>/.well-known/openid-configuration | jq .issuer` returns *exactly* your `ZITADEL_EXTERNALDOMAIN`. A mismatch here is the one the API refuses on, deliberately (OIDC Discovery §4.3), and it is much easier to see now than as a 500 later.

### 3. Mail: the part that takes longest and is nobody's favourite

Pick an **EU** SMTP provider and set `SMTP_*` in `.env`. Then the DNS work that
actually decides whether mail arrives:

- **SPF** — a TXT record naming the provider as allowed to send for the domain
- **DKIM** — the provider's signing key, as a TXT record
- **DMARC** — at least `p=none` to start, so you get reports

Without these, mail from a brand-new domain goes to spam, and from the customer's
side "we emailed you" is indistinguishable from "we did nothing".

> **Check:** send one to a Gmail address and a Microsoft one. Open *Show original* / *View message details*: SPF, DKIM and DMARC must all say **pass**. Both, not one — they disagree more often than you would expect.

### 4. Bring the stack up

`managed-bring-up.md` §1–§8, then **§8b** (the identity provider) and **§8d**
(the status page).

> **Check:** `/login` shows a **Sign in** button, not only a token box. If it does not, the web app was built before `VITE_OIDC_*` existed — rebuild it (§8b says so, and it is the easiest thing here to get wrong).

### 5. Become an operator

Sign in once at `/login` — this creates your account at the issuer. Then
`GET /api/me`, take `userId`, and (§8c):

```bash
DATABASE_URL=... pnpm --filter @openmig/api operator:add <userId> you@… "first operator"
```

> **Check:** sign in again — you land on **Access requests**, not the dashboard. That is `/api/me` reporting `operator: true`, which means the database, the issuer and the web app all agree about who you are.

### 6. The round trip, as a stranger

Use an address you control that is **not** the operator one, and preferably not
on the same domain.

1. Open the public site, follow the call to action, fill in the access form.
2. As the operator, see it in the queue. Grant it.
3. **Check the email arrives** — this is the step everything before it exists to reach.
4. In a different browser (or a private window), register at the issuer with that address, verify it, and sign in.
5. You should land on a dashboard owning the organisation that was provisioned.

> **Check, in the database:** the `tenant_member` row for that address reads `status = 'active'` and its `user_id` is a real subject rather than `pending:…`. That single row is the whole chain — the request, the grant, the invitation, the verified email and the binding — having worked.

### 7. Then a real migration

Only after 6. Connect a source, run one mailbox, watch the queues. That is a
different day's work and a different checklist.

---

## What will probably go wrong

Not pessimism — these are the ones worth recognising in three seconds instead of
an hour.

| Symptom | Almost always |
|---|---|
| `/login` has no Sign in button | The web app was built before `VITE_OIDC_*` was set. Rebuild it. |
| Sign-in returns, then everything 401s | `iss` mismatch — the issuer's discovery document declares a different name than `JWT_ISSUER`. Compare them character by character. |
| Signed in, but "not part of an organisation yet" | The invitation did not bind. Either the address differs from the one granted, or the issuer did not assert `email_verified` — that claim is the hinge of the whole flow (0093 T6b) and it is the one thing here never tested against a real issuer. |
| The email never arrives | SPF/DKIM/DMARC, nine times out of ten. Check the headers before touching any code. |
| The status page shows four red lights | It cannot reach `/api/ready` through the proxy. The page is right and the proxy is wrong. |
| Everything works, then breaks after a restart | Something is reading a container's internal name where a browser address belongs. |

## What Claude cannot do here, and will not pretend to

No credentials, no DNS, no access to the real box. Everything above marked
**Rob** needs one of those three. What can be done is to make sure each step
fails *loudly and for one reason* rather than quietly and for several — which is
what the checks in each step are for, and why the pre-work exists at all.

Bring back what any step actually said — the exact refusal, the header block, the
row — and the diagnosis is usually immediate.

## See also

- [`managed-bring-up.md`](./managed-bring-up.md) — the stack, phase by phase
- [ADR-0042](./adr/0042-who-holds-the-passwords.md) — why the issuer is replaceable, and what that costs here
- [workplan 0095](./workplans/0095-telling-somebody-they-are-in.md) — the email, and the account that does not exist yet
- [`status-page.md`](./status-page.md) — what the status page can and cannot tell you
