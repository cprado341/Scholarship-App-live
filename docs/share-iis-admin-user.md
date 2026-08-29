# Share The IIS App With An Admin User

Use this when another person should use the IIS-hosted Scholarship Agent app with full Admin access.

## Before Inviting

- Open the public IIS website from another computer and confirm it loads over HTTPS.
- Confirm `PUBLIC_APP_URL` in `iis\scholarship-agent.env.cmd` matches the public IIS URL.
- Restart the `ScholarshipAgent` service after changing `PUBLIC_APP_URL`.
- Sign in as the current Admin and open Settings.

## Create The Admin Invite

1. Open **Settings**.
2. Use **Share App Access** to confirm the website and login URLs use the IIS domain.
3. In **Invite New User**, enter the person's name and email.
4. Set role to `Admin`.
5. Leave Profile access empty; Admin users automatically receive all Profiles.
6. Click **Send Invite**.
7. Use **Open invite link** or **Open email draft** from **Latest Invite**.

## What The Invited Admin Does

1. Open the invite link.
2. Create a password.
3. Sign in at the IIS login URL.
4. Confirm Profiles, Student Files, Approvals, Audit, and Settings are visible.

## If The Link Uses The Wrong Domain

Update `PUBLIC_APP_URL` in:

```text
C:\Sites\ScholarshipAgent\iis\scholarship-agent.env.cmd
```

Then restart:

```powershell
Restart-Service ScholarshipAgent
```

Create a fresh invite after the restart. Existing pending links keep the domain they were created with.
