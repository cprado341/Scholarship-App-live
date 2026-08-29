import type { InviteEmailResult, SettingsRole } from "./types.ts";

export interface PortalInviteEmailInput {
  email: string;
  displayName: string;
  familyName: string;
  role: SettingsRole;
  inviteUrl: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendPortalInviteEmail(input: PortalInviteEmailInput): Promise<InviteEmailResult> {
  if (process.env.INVITE_DELIVERY_MODE?.trim().toLowerCase() === "manual") {
    return {
      email: input.email,
      status: "manual",
      inviteUrl: input.inviteUrl
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      email: input.email,
      status: "not_configured",
      inviteUrl: input.inviteUrl,
      error: "RESEND_API_KEY is not configured."
    };
  }

  const from = process.env.INVITE_EMAIL_FROM ?? "Scholarship Agent <onboarding@resend.dev>";
  const subject = `You're invited to ${input.familyName}'s Scholarship Agent portal`;
  const text = [
    `Hi ${input.displayName},`,
    "",
    `You've been invited as ${roleLabel(input.role)} to ${input.familyName}'s Scholarship Agent portal.`,
    "Use this secure link to set your password and sign in:",
    input.inviteUrl,
    "",
    "If you were not expecting this invite, you can ignore this email."
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #172026;">
      <h1 style="font-size: 22px;">Scholarship Agent invite</h1>
      <p>Hi ${escapeHtml(input.displayName)},</p>
      <p>You've been invited as <strong>${escapeHtml(roleLabel(input.role))}</strong> to ${escapeHtml(input.familyName)}'s Scholarship Agent portal.</p>
      <p><a href="${escapeHtml(input.inviteUrl)}" style="display: inline-block; background: #1e6f6b; color: white; padding: 10px 14px; border-radius: 8px; text-decoration: none; font-weight: 700;">Accept invite</a></p>
      <p style="font-size: 13px; color: #60707a;">If the button does not work, paste this link into your browser:<br />${escapeHtml(input.inviteUrl)}</p>
      <p style="font-size: 13px; color: #60707a;">If you were not expecting this invite, you can ignore this email.</p>
    </div>
  `;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `portal-invite-${input.email.toLowerCase()}`
      },
      body: JSON.stringify({
        from,
        to: input.email,
        subject,
        text,
        html
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(payload?.message ?? payload?.error ?? `Email provider returned ${response.status}.`);
      console.error("[portal-invite-email] Resend send failed", {
        status: response.status,
        recipient: input.email,
        from,
        message
      });
      return {
        email: input.email,
        status: "failed",
        inviteUrl: input.inviteUrl,
        error: message
      };
    }
    return {
      email: input.email,
      status: "sent",
      inviteUrl: input.inviteUrl,
      providerMessageId: typeof payload?.id === "string" ? payload.id : undefined
    };
  } catch (error) {
    return {
      email: input.email,
      status: "failed",
      inviteUrl: input.inviteUrl,
      error: error instanceof Error ? error.message : "Email send failed."
    };
  }
}

function roleLabel(role: SettingsRole): string {
  return role === "Employee" ? "Contributor" : role;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
