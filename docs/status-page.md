# The status page, and what it cannot tell you

`status.ownpace.eu` — the page served by the `gatus` service in
[`deploy/compose/managed.yml`](../deploy/compose/managed.yml), configured by
[`deploy/compose/gatus.yaml`](../deploy/compose/gatus.yaml).

## Start here: it runs inside the thing it watches

**This page cannot tell you that Ownpace is down.** It runs as a container in
the same stack, on the same machine. When the box is off, the network is gone,
or Docker has fallen over, the page is off too — and an unreachable status page
looks identical to a status page nobody has visited.

That is a deliberate trade (owner decision, 2026-08-22) and not an oversight.
The alternative is a second machine in a different place, which is the right
answer eventually and is a real cost now: another host to patch, another deploy
path, another thing to forget. Before there are customers, a page that is honest
about its own blind spot beats a second machine.

The page says so itself, in the button next to its heading, because a status
page that quietly overstates what it knows is worse than no status page at all.

## What it CAN tell you, and these are worth having

**Is a provider down.** Microsoft and Google go down, and when they do, every
migration out of them stalls. That looks exactly like Ownpace being broken from
the customer's side, and it is the single most common thing a support message is
actually about. A red light under **Sources** settles it in a glance.

**Is part of Ownpace unwell while the rest serves.** The **Ownpace** group reads
`/api/ready` field by field, so a sign-in outage shows as a sign-in outage rather
than turning the whole page red. That distinction is the difference between
"you cannot log in for a bit" and "your migration has stopped", and they are not
the same conversation.

**Was there an outage.** History lives in SQLite on its own volume — deliberately
*not* the Postgres it watches, which would take the record away at the exact
moment somebody wanted to read it. So the page can still tell you what happened
last Tuesday even though it could not tell you at the time.

## What the groups mean

| Group | What a red light means |
|---|---|
| **Ownpace** | Something of ours. `Web app` and `API` are liveness; `Database` and `Sign-in` read the two fields of `/api/ready` that can genuinely fail. |
| **Sources** | Somebody else's service that migrations read FROM. Nothing is wrong with Ownpace; migrations out of that provider will be stalled until it returns. |
| **Targets** | A destination we RECOMMEND (ADR-0011). Self-hosted targets are not listed: those are the customer's to operate, and reporting on infrastructure we do not run would be claiming a responsibility we explicitly decline. |

## Why the checks are shaped the way they are

**`/api/health` versus `/api/ready`.** `/health` returns `{ status: 'ok' }` from
a literal — it answers "is this process running" and answers it correctly, which
is what a compose healthcheck wants. It is useless to a status page: it reports
green while Postgres is unreachable and every request is failing. `/api/ready`
is the one that can say no.

**Readiness answers 200 while DEGRADED, on purpose.** So the `Database` and
`Sign-in` checks read `[BODY].database == up` rather than the status code. A
load balancer that pulled the API out of rotation because sign-in was unwell
would turn a partial problem into a total one.

**Provider checks use unauthenticated discovery documents.** Stable, public, no
rate limits, no credential. A status check that has to hold a customer's token
is a check that goes red for the wrong reasons — and one that quietly depends on
somebody's OAuth grant still being valid.

**It probes `WEB_URL`, not `http://api:3001`.** The internal name would prove the
container can talk to itself. The browser address exercises the path a customer
actually takes: reverse proxy, certificate, and the same-origin `/api` proxy.

## Bringing it up

It comes up with the rest of the stack. `STATUS_PORT` (default `3124`) is where
it listens; put it behind the reverse proxy at `status.<your domain>` alongside
the app.

```bash
docker compose -f deploy/compose/managed.yml up -d gatus
curl -fsS "http://localhost:${STATUS_PORT:-3124}/health"
```

Changing what is watched is an edit to `deploy/compose/gatus.yaml` and a
restart. That file is in git and reviewed like everything else, which is the
main reason Gatus was chosen over Uptime Kuma — the latter keeps its monitors in
a SQLite blob edited through a web UI, which cannot be diffed, reviewed or
reproduced on a fresh machine.

## Moving it out later

When there are customers, this belongs on a small EU host that is not this one —
€4–5/month, and it is what makes "is Ownpace down" answerable. That move is a
deploy change, not a rewrite: `gatus.yaml` and every endpoint in it stay exactly
as they are, pointed at the same public URLs from a machine that is not this one.
Delete the `gatus` service from `managed.yml`, run the same config there, and the
history comes with the volume.

Keep it in the EU. Atlassian Statuspage, Better Stack and Instatus are US SaaS,
and Upptime runs on GitHub Actions and Pages — also US. A US-hosted status page
on the front of a product that sells getting off US cloud is the kind of detail a
prospect checks.

## See also

- [`managed-bring-up.md`](./managed-bring-up.md) — standing the stack up
- [ADR-0011](./adr/0011-targets-managed-eu-no-selfhosted-mail.md) — which targets are recommended, and why self-hosted ones are the customer's
- [`operator-runbook.md`](./operator-runbook.md) — running it once it is up
