# Scholarship Agent App Functional Handoff

## Current State

The project is live as a Vercel preview-style portal:

- Production URL: https://scholarship-agent-app.vercel.app
- GitHub repo: https://github.com/cpado341/scholarship-agent-app
- Vercel project: `kylie-s-projects3/scholarship-agent-app`
- Current app mode: working preview with seeded/in-memory serverless data
- Local app mode: working local portal with SQLite and encrypted local profile data

The Vercel deployment demonstrates the core user experience:

- Login-protected portal
- Dashboard for scholarship matches, essays, approvals, and audit events
- Weekly agent run endpoint
- Human approval gates before submit/upload/signature-style actions
- Safe browser-session planning that stops before submit

Do not treat the current Vercel deployment as production-ready. The deployed preview stores runtime data in warm serverless function memory, so data can reset across cold starts or deployments.

## Production Goal

Make this a durable, secure family scholarship portal where a parent/student can:

1. Create real student profiles.
2. Upload resumes, transcripts, recommendation letters, and essays.
3. Run scholarship discovery and matching on a schedule.
4. Review drafted essays and application plans.
5. Approve or reject every external side effect.
6. Preserve all application history, approvals, deadlines, documents, and audit logs.

The core invariant must remain: the app must never submit, upload, email, sign, pay, request recommendations, or attest on behalf of the family without explicit approval.

## Recommended Production Architecture

Use Vercel for the web app and serverless API, plus durable managed storage.

- App hosting: Vercel
- Database: Supabase Postgres or Neon Postgres
- Auth: Supabase Auth, or a hardened custom auth layer backed by Postgres
- File storage: Supabase Storage or Vercel Blob/private object storage
- Realtime: Supabase Realtime or database-backed job status polling
- Scheduled jobs: Vercel Cron
- Long browser automation: separate worker service if Playwright sessions become heavy
- Secrets: Vercel environment variables, not committed files

Useful references:

- Vercel Marketplace storage can provision Postgres providers such as Neon and Supabase and inject credentials as environment variables: https://vercel.com/docs/marketplace-storage
- Vercel storage overview explains when to use Blob versus database storage: https://vercel.com/docs/storage
- Supabase Auth integrates with Postgres and Row Level Security: https://supabase.com/docs/guides/auth
- Supabase Row Level Security should be enabled for exposed tables: https://supabase.com/docs/guides/database/postgres/row-level-security
- Vercel Cron Jobs can be configured in `vercel.json`, and `CRON_SECRET` is recommended for securing cron invocations: https://vercel.com/docs/cron-jobs/manage-cron-jobs

## Work Required To Make It Functional

### 1. Replace Preview State With Durable Postgres

Create production tables for:

- `families`
- `users` or Supabase-auth-linked `profiles`
- `students`
- `student_documents`
- `scholarships`
- `scholarship_requirements`
- `essay_drafts`
- `application_plans`
- `approvals`
- `audit_events`
- `agent_runs`
- `agent_run_events`
- `browser_sessions`

Every family-owned row must include `family_id`.

Minimum database rules:

- Enforce foreign keys.
- Add indexes for `family_id`, deadlines, status, and pending approvals.
- Enable Row Level Security if using Supabase.
- Ensure authenticated users only access their own `family_id`.
- Keep service-role/server keys server-side only.

### 2. Replace Preview Auth

The current Vercel preview uses a simple environment-password login. Replace it with one of:

- Supabase Auth with email/password or magic links.
- Auth.js or another production-grade auth library with Postgres sessions.

Minimum auth requirements:

- Password reset flow.
- Session expiration.
- Parent/student roles.
- Family workspace membership.
- No shared hardcoded password.
- No auth secrets in source control.

### 3. Add Real Document Uploads

Current local files and preview placeholders need real storage.

Required document capabilities:

- Upload resume, transcript, recommendation letter, essay, and “other” documents.
- Store metadata in Postgres.
- Store file bytes in private object storage.
- Restrict file access by family.
- Track status: available, missing, needs update, expired.
- Never send/upload a file externally without an approval record.

### 4. Persist Agent Runs And Realtime Progress

The current portal shows live-ish progress locally and preview data on Vercel. Production should persist job state.

Implement:

- `agent_runs` table with status, timestamps, error, summary.
- `agent_run_events` table for step-by-step progress.
- Realtime subscription or polling in the dashboard.
- Retry-safe weekly pipeline.
- Idempotent scholarship dedupe by normalized URL/source.

### 5. Connect Real Scholarship Discovery

The current discovery source is fixture data. Production needs controlled real-world discovery.

Recommended v1 discovery sources:

- Curated source list maintained by the parent.
- Public scholarship pages.
- Common scholarship portals where terms allow browser assistance.
- School/local district scholarship pages.

Discovery agent requirements:

- Store source URL and extraction timestamp.
- Sanitize untrusted webpage text for prompt injection.
- Extract award, deadline, eligibility, requirements, documents, essay prompts, and risks.
- Keep low-confidence fields as review tasks.
- Do not invent eligibility or student claims.

### 6. Harden Essay Drafting

Production essay drafting must remain student-grounded.

Required behavior:

- Student interview answers are the primary source.
- Drafts cite which profile/interview facts they used.
- Unsupported claims are flagged.
- Sensitive topics require explicit student/parent confirmation.
- Essay status flow: draft, needs student review, parent reviewed, approved.

### 7. Build The Real Application Prep Workflow

Production application plans should map scholarship requirements to student data and documents.

Required behavior:

- Missing fields become review tasks.
- Financial need, demographic information, signatures, attestations, recommendations, and fees are never assumed.
- Browser plans stop at review before submit.
- Upload, email, recommendation request, signature, payment, and submit require separate approval types.

### 8. Decide Browser Automation Hosting

Vercel serverless functions are not ideal for long Playwright sessions. Keep Vercel for the portal, but use a separate worker if real browser automation becomes heavy.

Options:

- Local browser assistant only for v1.
- Hosted worker on Fly.io, Render, or another long-running service.
- Queue jobs from Vercel to the worker.

Required safety behavior:

- The worker cannot click final submit without approval.
- Browser actions are logged.
- Credentials are never stored in v1.
- Parent/student logs into portals interactively.

### 9. Productionize Vercel Cron

Current `vercel.json` includes a weekly cron path. Production work:

- Confirm cron schedule and timezone expectation.
- Ensure the cron endpoint accepts Vercel cron requests.
- Validate `CRON_SECRET`.
- Write the run result to Postgres.
- Notify the family when review items are created.

### 10. Add Notifications

Useful notification channels:

- Email summary for pending approvals.
- Deadline reminders.
- Weekly “new scholarships found” digest.
- Failed agent run alerts.

Minimum notification rule:

- Notifications may remind and summarize, but must not approve or submit anything.

## Security And Privacy Checklist

- Rotate the current preview password before real use.
- Move all secrets to Vercel environment variables.
- Do not commit `.local/`, `data/app.sqlite`, database dumps, transcripts, resumes, or uploaded documents.
- Encrypt sensitive profile fields at rest if not relying solely on provider-managed encryption.
- Use per-family authorization checks on every server route.
- Add audit events for all sensitive actions and approval decisions.
- Add rate limiting to login and agent endpoints.
- Add backup/export plan for family data.
- Add deletion/export support for student data.

## Suggested Implementation Sequence

1. Pick storage provider: Supabase is recommended because it covers Postgres, Auth, Storage, and Realtime in one platform.
2. Create the production database schema and RLS policies.
3. Replace `api/[...path].js` in-memory state with database-backed route handlers.
4. Replace preview login with Supabase Auth or production session auth.
5. Add document upload and private file access.
6. Persist weekly runs, approvals, essay drafts, scholarships, and audit events.
7. Add real scholarship source ingestion.
8. Add production notification emails.
9. Add a worker for browser automation if needed.
10. Run end-to-end acceptance testing with one real scholarship application that stops before submission.

## Acceptance Criteria For “Functional”

The application is functional when:

- A parent can sign up/sign in securely.
- A family workspace persists after redeploys and cold starts.
- A student profile and documents can be created and edited.
- Weekly discovery creates durable scholarship matches.
- At least three real applications can reach “ready for review.”
- Essay drafts are grounded in student-provided answers.
- Approval gates are enforced server-side.
- No final external action can happen without approval.
- Audit history survives redeploys.
- Deadline and approval reminders work.

## Current Known Limitations

- Vercel deployment uses in-memory preview data.
- GitHub repo is private, but Vercel is not currently connected to GitHub auto-deploy because Vercel reported that the GitHub login connection must be added in the Vercel account.
- Real scholarship discovery is not connected yet.
- Real document upload/storage is not connected yet.
- Long-running browser automation is not production-hosted yet.
- There is no durable Postgres schema or RLS policy set yet.

## Handoff Notes

Keep these files in mind:

- `api/[...path].js`: Vercel preview API. Replace this with durable database-backed routes.
- `src/db.ts`: Local SQLite repository used by the local version.
- `src/agents/*`: Core agent logic and safety policies.
- `public/*`: Current dashboard UI.
- `vercel.json`: Vercel static/API routing and cron configuration.
- `DEPLOYMENT.md`: Existing deployment checklist.

The fastest path to a real product is not adding more UI first. It is replacing preview storage/auth with Supabase or Neon-backed persistence, then keeping the existing approval-gated workflow intact.
