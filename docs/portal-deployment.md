# Portal Deployment Notes

This repo now runs as a login-protected local portal. To host it for real family use, keep the same application boundaries but move secrets and storage into managed services.

## Required Production Settings

- `PORTAL_ADMIN_EMAIL`: parent login email for the first account.
- `PORTAL_ADMIN_PASSWORD`: strong temporary password for the first account.
- `CRON_SECRET`: long random token used by scheduled jobs.
- `NODE_ENV=production`: makes the session cookie require HTTPS.

## Recommended Hosted Shape

1. Host the web app behind HTTPS.
2. Replace local SQLite with Postgres.
3. Store documents in encrypted object storage.
4. Run the weekly pipeline from a scheduled worker or cron endpoint.
5. Keep browser automation in a server-side worker so credentials and OpenAI keys never reach the browser.
6. Keep the same approval-gate invariant: no submit, signature, payment, recommendation request, email, or upload without an approval record.

## Realtime Behavior

The current app uses server-sent events at `GET /api/events`. For a hosted multi-instance deployment, replace the in-memory event hub with a shared realtime layer such as Supabase Realtime, Redis pub/sub, or a durable job-status table with subscriptions.

## Database Migration Target

Each user-owned table should include `family_id`, and production Postgres should enforce row-level security so users can only read and write rows belonging to their family workspace.
