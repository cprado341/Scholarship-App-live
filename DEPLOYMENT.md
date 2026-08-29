# Deploying This Project

This repo is now safe to commit locally and includes a Vercel preview API under `api/[...path].js`.

The preview deployment works with seeded in-memory data so the login, dashboard, weekly run, approval queue, and safety gates can be demonstrated on Vercel. The repo also includes the SaaS private-beta foundation for a Next.js App Router build.

It is not production-ready until the in-memory preview API is replaced with hosted storage.

## Why

The local app stores state in `data/app.sqlite` and serves through a long-running local Node server. The Vercel preview API stores state in warm function memory. Neither is durable production storage on Vercel. For production, move app data to hosted Postgres and document files to private object storage.

## Recommended Vercel Production Stack

- Vercel for the Next.js portal frontend and serverless API routes.
- Clerk Organizations for invite-only family workspaces.
- Neon Postgres for app data.
- Vercel Blob private storage for transcripts, resumes, recommendation letters, screenshots, and proof files.
- Vercel Cron for weekly scholarship agent runs.
- A local Chrome companion for scholarship portal preparation; hosted browser automation is deferred.

## Environment Variables

Set these in Vercel before production deploy:

- `PORTAL_ADMIN_EMAIL`
- `PORTAL_ADMIN_PASSWORD`
- `CRON_SECRET`
- `PUBLIC_APP_URL`
- `APP_ENCRYPTION_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `PLATFORM_ADMIN_EMAILS`
- `INVITE_DELIVERY_MODE=manual` to create Settings invite links without sending email
- `RESEND_API_KEY` and `INVITE_EMAIL_FROM` for automatic Settings user invite emails
- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`

## Deploy Flow

1. Push this repo to GitHub.
2. Create/import the project in Vercel.
3. Add the environment variables above.
4. Provision Clerk, Neon, and Vercel Blob in Vercel Marketplace.
5. Apply `src/saas/schema.sql` to Neon.
6. Switch the API adapter from local SQLite/in-memory preview state to the Neon repository adapter.
7. Validate Clerk organization isolation, private document access, weekly cron locks, approval gates, and no-submit safety checks.
8. Promote to production.

## Current Local Commands

Run locally:

```bash
./scripts/start-portal.command
```

Run tests:

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --disable-warning=ExperimentalWarning tests/*.test.ts
```
