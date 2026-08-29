# IIS Deployment Guide

This app is a Node-powered portal. On IIS, run Node as a private Windows service on `127.0.0.1:4317`, then use IIS as the public reverse proxy for HTTP/HTTPS traffic.

## Server Requirements

- Windows Server 2019 or newer.
- IIS Web Server role.
- Node.js 24 or newer, 64-bit.
- IIS URL Rewrite 2.1.
- IIS Application Request Routing 3.0.
- NSSM for running the Node portal as a Windows service.
- A TLS certificate for the public hostname.

Keep the Node service bound to `127.0.0.1`; only IIS should be exposed to the internet.

## Build The IIS Package

From the project folder on your development machine:

```bash
node scripts/build-iis-package.mjs
```

If Node is not on your PATH in Codex, use the bundled runtime:

```bash
/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/build-iis-package.mjs
```

Copy `dist/scholarship-agent-iis` to the Windows server, for example:

```text
C:\Sites\ScholarshipAgent
```

## Configure Secrets

On the Windows server, copy:

```text
C:\Sites\ScholarshipAgent\iis\scholarship-agent.env.example.cmd
```

to:

```text
C:\Sites\ScholarshipAgent\iis\scholarship-agent.env.cmd
```

Then edit `scholarship-agent.env.cmd` and set:

- `PUBLIC_APP_URL` to your HTTPS website URL.
- `PORTAL_ADMIN_EMAIL` to the admin login email.
- `PORTAL_ADMIN_PASSWORD` to a strong password.
- `CRON_SECRET` to a long random token.
- `APP_ENCRYPTION_KEY` to a 32-byte base64 key.
- `INVITE_DELIVERY_MODE=manual` unless email sending is fully configured.

Do not commit or share `scholarship-agent.env.cmd`.

## Install The Node Service

Open PowerShell as Administrator and run:

```powershell
cd C:\Sites\ScholarshipAgent
powershell -ExecutionPolicy Bypass -File .\iis\install-service.ps1 -AppRoot C:\Sites\ScholarshipAgent -NssmExe C:\Tools\nssm\nssm.exe -NodeExe "C:\Program Files\nodejs\node.exe"
```

Confirm the private app is running:

```powershell
Invoke-WebRequest http://127.0.0.1:4317/api/me
```

A `401` response is expected when signed out; it means the app is alive.

## Install The IIS Site

Install IIS URL Rewrite and Application Request Routing first. Then run:

```powershell
cd C:\Sites\ScholarshipAgent
powershell -ExecutionPolicy Bypass -File .\iis\install-iis-site.ps1 -SiteName "Scholarship Agent" -PhysicalPath C:\Sites\ScholarshipAgent -BindingHost scholarships.example.com
```

Replace `scholarships.example.com` with your real host name. The site uses `web.config` to reverse-proxy every request to `http://127.0.0.1:4317`.

## Add HTTPS

In IIS Manager:

1. Open the Scholarship Agent site.
2. Choose **Bindings**.
3. Add an `https` binding for your hostname.
4. Select the TLS certificate.
5. Keep ports `80` and `443` open in Windows Firewall.

For production, redirect HTTP to HTTPS with IIS URL Rewrite or your edge firewall.

## Backups

Back up these files and folders:

- `data\app.sqlite`
- `data\documents`
- `.local\secret.key`
- `iis\scholarship-agent.env.cmd`

The SQLite file and encryption key must be restored together. If `.local\secret.key` is lost, encrypted student profile data cannot be decrypted.

## Updating The App

1. Build a fresh IIS package.
2. Stop the `ScholarshipAgent` Windows service.
3. Copy the new package over the existing folder, preserving:
   - `data`
   - `.local`
   - `iis\scholarship-agent.env.cmd`
4. Start the `ScholarshipAgent` service.
5. Open the site and verify login, Profiles, Student Files, Approvals, and Settings.

## Sharing With Another Admin

After the IIS site is reachable over HTTPS, follow [share-iis-admin-user.md](share-iis-admin-user.md). You can also run this readiness check from elevated PowerShell:

```powershell
cd C:\Sites\ScholarshipAgent
powershell -ExecutionPolicy Bypass -File .\iis\check-share-ready.ps1 -AppRoot C:\Sites\ScholarshipAgent
```

## Troubleshooting

`502.3 Bad Gateway` usually means the Node service is not running or ARR proxy is not enabled.

`500.19` usually means IIS URL Rewrite or ARR is missing, or IIS cannot read `web.config`.

`404` on every page usually means the IIS site physical path is wrong.

If the service does not start, check:

```text
C:\Sites\ScholarshipAgent\logs\service.err.log
C:\Sites\ScholarshipAgent\logs\service.out.log
```

If invite links point to the wrong domain, update `PUBLIC_APP_URL` in `iis\scholarship-agent.env.cmd` and restart the service.

## Security Checklist

- Keep `HOST=127.0.0.1`.
- Use HTTPS publicly.
- Use a strong `PORTAL_ADMIN_PASSWORD`.
- Keep `scholarship-agent.env.cmd`, `.local`, and `data` readable only by administrators and the service account.
- Do not store portal passwords in the app.
- Keep scholarship submissions manual; the app should not click final submit buttons.
