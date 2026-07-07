// No real email provider wired up yet (pilot starts from zero infra, §3) —
// this logs the link so the auth flow is testable end-to-end. Swap the body
// of this function for a real provider (Postmark/SES/Resend) before
// onboarding real tenants; nothing else in the auth flow needs to change.
export async function sendMagicLinkEmail(email: string, link: string): Promise<void> {
  console.log(`[mailer] Magic link for ${email}: ${link}`);
}
