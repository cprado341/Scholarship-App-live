import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand login-brand">
          <div className="mark">SA</div>
          <div>
            <strong>Scholarship Agent</strong>
            <span>Invite-only family beta</span>
          </div>
        </div>
        <SignIn routing="path" path="/sign-in" />
      </section>
    </main>
  );
}
