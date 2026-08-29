import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export default function DashboardPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">SA</div>
          <div>
            <strong>Scholarship Agent</strong>
            <span>Family beta workspace</span>
          </div>
        </div>
        <div className="saas-switcher">
          <OrganizationSwitcher hidePersonal />
        </div>
        <nav className="nav">
          <button className="nav-item active" data-view="overview">Overview</button>
          <button className="nav-item" data-view="profiles">Profiles</button>
          <button className="nav-item" data-view="student-files">Students Files</button>
          <button className="nav-item" data-view="scholarships">Scholarships</button>
          <button className="nav-item" data-view="essays">Essays</button>
          <button className="nav-item" data-view="approvals">Approvals</button>
          <button className="nav-item" data-view="audit">Audit</button>
          <button className="nav-item" data-view="settings">Settings</button>
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Invite-only SaaS beta</p>
            <h1>Application Review Queue</h1>
            <p id="portalMeta" className="compact">Connecting to family workspace...</p>
          </div>
          <div className="actions">
            <button id="runPipeline" className="primary">Run No-Essay Search</button>
            <button id="refresh" className="ghost">Refresh</button>
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>

        <section id="status" className="status" hidden></section>
        <section id="content"></section>
      </main>
      <section id="profileEditor" className="modal-layer" hidden></section>
      <script type="module" src="/app.js"></script>
    </div>
  );
}
