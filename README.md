# Scholarship Agent App

A private local web app for finding, ranking, drafting, prefilling, and reviewing college scholarship applications for high school juniors and seniors.

The current implementation keeps the local portal runnable while adding the SaaS private-beta foundation: Clerk organization workspaces, tenant-scoped data contracts, Neon Postgres schema, Vercel Blob private document metadata, run locks, and local Chrome companion tokens.

## Run

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --disable-warning=ExperimentalWarning src/server.ts
```

Then open `http://127.0.0.1:4317`.

You can also double-click [scripts/start-portal.command](scripts/start-portal.command) to start the portal in a Terminal window.

Default local portal login:

- Email: `parent@example.com`
- Password: `change-me-now`

Before hosting outside your machine, set `PORTAL_ADMIN_EMAIL`, `PORTAL_ADMIN_PASSWORD`, and `CRON_SECRET`. To use manual Settings invites, set `INVITE_DELIVERY_MODE=manual` and `PUBLIC_APP_URL`. To send real invite emails, set `RESEND_API_KEY`, `INVITE_EMAIL_FROM`, and remove or change manual delivery mode after verifying a sending domain.

## IIS / Windows Server

This app can run on IIS by using IIS as a reverse proxy to the local Node portal.

Build the Windows/IIS package:

```bash
node scripts/build-iis-package.mjs
```

Then copy `dist/scholarship-agent-iis` to the Windows server and follow [docs/iis-deployment.md](docs/iis-deployment.md).

To invite another person into the IIS-hosted app as an Admin, follow [docs/share-iis-admin-user.md](docs/share-iis-admin-user.md).

## SaaS Beta

The SaaS beta target is invite-only families on Vercel with Next.js App Router, Clerk Organizations, Neon Postgres, and Vercel Blob private storage.

```bash
npm install
npm run dev:next
```

Set the Clerk, Neon, Blob, encryption, cron, and platform admin variables from `.env.example` before running the SaaS build. The local Node portal remains available with the `start` script while the production adapters are completed.

## Test

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --disable-warning=ExperimentalWarning tests/*.test.ts
```

## Automation Commands

Run the weekly agent pipeline without opening the web server:

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --disable-warning=ExperimentalWarning src/automation.ts weekly
```

Run the daily approval/deadline review:

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --disable-warning=ExperimentalWarning src/automation.ts review
```

## What Works Now

- Dashboard for students, scholarships, essays, application prep, approvals, and audit events.
- Login-protected parent portal with HttpOnly session cookies.
- Family workspace scoping across the local data model.
- SaaS workspace tables for Clerk organizations, family members, beta invite audit mirrors, run locks, and companion tokens.
- Realtime dashboard updates with server-sent events during agent runs.
- Secret-protected weekly cron endpoint at `GET` or `POST /api/cron/weekly`.
- Weekly agent pipeline that discovers fixture scholarships, deduplicates, scores fit, drafts essays from interview data, prepares fill plans, and queues review approvals.
- SQLite persistence in `data/app.sqlite`.
- AES-GCM encryption for sensitive student profile JSON using a local key in `.local/secret.key`.
- Browser-session planning that removes any submit action and stops at review.
- Local Chrome companion tokens for scoped, one-time handoff to the local submission flow.
- Settings user invites with secure password setup links; manual delivery creates copyable links, and email delivery uses Resend when configured.
- Tests for scoring, prompt-injection stripping, essay grounding, approval gates, and safe browser steps.

## V1 Safety Rules

- The app never submits applications automatically.
- Portal passwords are not stored.
- Unknown fields stay blank and become review tasks.
- Agents must not invent achievements, demographic claims, income details, signatures, recommendations, or attestations.
- Every sensitive action requires an approval record before it can proceed.

## Portal Endpoints

- `POST /api/auth/login` signs in and sets the session cookie.
- `/invite.html` lets invited users set their password from an emailed Settings invite.
- `POST /api/auth/accept-invite` accepts an invite token, creates the user's password, and signs them in.
- `POST /api/auth/logout` clears the session.
- `GET /api/me` returns the signed-in user and family.
- `GET /api/events` streams live agent progress and dashboard changes.
- `POST /api/cron/weekly` runs the weekly pipeline when called with `Authorization: Bearer $CRON_SECRET`.

See [docs/portal-deployment.md](docs/portal-deployment.md) for the hosted portal path.
See [DEPLOYMENT.md](DEPLOYMENT.md) for the repository and Vercel deployment checklist.
