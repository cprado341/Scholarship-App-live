let dashboard = null;
let activeView = "overview";
let currentUser = null;
let currentFamily = null;
let portalRuntime = "local";
let eventSource = null;
let activeReviewApprovalId = null;
let activeStudentFilesCategory = "all";
let latestInviteResults = [];

const SETTINGS_ROLES = ["Admin", "Employee", "Guest", "Viewer"];
const SETTINGS_CAPABILITIES = [
  ["manageSettings", "Manage settings"],
  ["manageUsers", "Manage users"],
  ["manageProfiles", "Edit profiles"],
  ["manageScholarships", "Manage scholarships"],
  ["prepareApplications", "Prep applications"],
  ["approveActions", "Approve actions"],
  ["viewAudit", "View audit"]
];

const CUSTOM_FIELD_TARGETS = [
  ["student_profile", "Profile"],
  ["scholarship", "Scholarship"],
  ["application", "Application"],
  ["document", "Document"],
  ["approval", "Approval"]
];

const CUSTOM_FIELD_TYPES = [
  ["text", "Text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["date", "Date"],
  ["yes_no", "Yes/No"]
];
const TOP_REVIEW_MATCH_LIMIT = 5;
const PROFILE_STORAGE_VERSION = 1;
const DOCUMENT_STORAGE_VERSION = 1;
const SETTINGS_STORAGE_VERSION = 1;
const DOCUMENT_DB_NAME = "scholarship-agent-documents";
const DOCUMENT_STORE_NAME = "files";
const DOCUMENT_TYPES = [
  ["transcript", "Transcript"],
  ["resume", "Resume"],
  ["recommendation", "Recommendation"],
  ["essay", "Essay"],
  ["other", "Other"]
];
const DOCUMENT_FILE_ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png";
const MONTH_OPTIONS = [
  ["", "Unknown"],
  ["January", "January"],
  ["February", "February"],
  ["March", "March"],
  ["April", "April"],
  ["May", "May"],
  ["June", "June"],
  ["July", "July"],
  ["August", "August"],
  ["September", "September"],
  ["October", "October"],
  ["November", "November"],
  ["December", "December"]
];
const SCHOLARSHIP_APPLICATION_URL_FALLBACKS = {
  "STEM Next Generation Award": "https://scholarships360.org/scholarships/search/10000-no-essay-scholarship/",
  "Texas Opportunity No-Essay Grant": "https://www.niche.com/colleges/scholarships/no-essay-scholarship/",
  "Merit Snapshot No-Essay Scholarship": "https://www.appily.com/scholarships/easy-money-scholarship",
  "Community Service Quick Apply Award": "https://bold.org/scholarships/the-be-bold-no-essay-scholarship/",
  "Too Cool to Pay for School Scholarship": "https://accessscholarships.com/1k-too-cool-to-pay-for-school/"
};

const content = document.querySelector("#content");
const statusBox = document.querySelector("#status");
const runButton = document.querySelector("#runPipeline");
const refreshButton = document.querySelector("#refresh");
const logoutButton = document.querySelector("#logout");
const portalMeta = document.querySelector("#portalMeta");
const profileEditor = document.querySelector("#profileEditor");
const nav = document.querySelector(".nav");
const nativeFetch = window.fetch.bind(window);

window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  return normalizeApiFetchResponse(input, response);
};

async function normalizeApiFetchResponse(input, response) {
  const requestUrl = requestUrlFromFetchInput(input);
  if (!requestUrl || !requestUrl.pathname.startsWith("/api/")) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response;

  const text = await response.clone().text().catch(() => "");
  if (!looksLikeHtml(text) && text.trim()) return response;

  const redirectedToLogin = response.redirected || new URL(response.url || requestUrl.href, window.location.href).pathname.startsWith("/login");
  const message = redirectedToLogin
    ? "Your session expired. Sign in again."
    : "The app received a web page instead of app data. Refresh the portal and try again.";
  return new Response(JSON.stringify({ error: message, loginUrl: "/login?next=/portal.html" }), {
    status: response.ok ? 502 : response.status,
    statusText: response.statusText || "Invalid API response",
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function requestUrlFromFetchInput(input) {
  try {
    const rawUrl = typeof input === "string" ? input : input?.url;
    return rawUrl ? new URL(rawUrl, window.location.href) : null;
  } catch {
    return null;
  }
}

function looksLikeHtml(text) {
  const trimmed = String(text ?? "").trim().toLowerCase();
  return !trimmed || trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.includes("<body");
}

nav.addEventListener("click", (event) => {
  const button = event.target.closest(".nav-item");
  if (!button) return;
  activeView = button.dataset.view;
  setActiveNav(activeView);
  render();
});

content.addEventListener("click", (event) => {
  const addProfileButton = event.target?.closest?.("[data-add-profile]");
  if (!addProfileButton) return;
  event.preventDefault();
  openProfileEditor();
});

runButton.addEventListener("click", async () => {
  await withStatus("Running no-essay scholarship search...", async () => {
    await syncSavedProfilesToServer();
    await syncSavedSettingsToServer();
    await syncSavedDocumentsToServer();
    const response = await fetch("/api/runs/weekly", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not run the no-essay search.");
    dashboard = await hydrateDashboard(payload.dashboard);
    setStatus(payload.run.summary);
    render();
  });
});

refreshButton.addEventListener("click", loadDashboard);
if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login?next=/portal.html";
  });
}

bootPortal();

async function bootPortal() {
  const response = await fetch("/api/me");
  if (response.status === 401) {
    window.location.href = "/login?next=/portal.html";
    return;
  }
  const payload = await response.json();
  if (!response.ok) {
    setStatus(payload.error || "Could not load the portal.");
    if (payload.loginUrl) window.location.href = payload.loginUrl;
    return;
  }
  currentUser = payload.user;
  currentFamily = payload.family;
  portalRuntime = payload.runtime ?? "local";
  portalMeta.textContent = `${payload.family.name} · signed in as ${payload.user.displayName}`;
  connectLiveEvents();
  await loadDashboard();
}

async function loadDashboard() {
  await withStatus("Refreshing workspace...", async () => {
    const response = await fetch("/api/dashboard");
    if (response.status === 401) {
      window.location.href = "/login?next=/portal.html";
      return;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load dashboard data.");
    dashboard = await hydrateDashboard(payload, { sync: true });
    setStatus("Workspace refreshed.");
    render();
  });
}

function render() {
  if (!dashboard) return;
  syncCustomNavTabs();
  setActiveNav(activeView);
  if (activeView === "overview") return renderOverview();
  if (activeView === "profiles") return renderProfiles();
  if (activeView === "student-files") return renderStudentFiles();
  if (activeView === "scholarships") return renderScholarships();
  if (activeView === "essays") return renderEssays();
  if (activeView === "approvals") return renderApprovals();
  if (activeView === "audit") return renderAudit();
  if (activeView === "settings") return renderSettings();
  if (activeView.startsWith("custom-tab:")) return renderCustomTab(activeView.replace("custom-tab:", ""));
  activeView = "overview";
  setActiveNav(activeView);
  return renderOverview();
}

function setActiveNav(view) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
}

async function hydrateDashboard(incomingDashboard, options = {}) {
  if (!incomingDashboard) return incomingDashboard;
  let next = mergeSavedDocumentsIntoDashboard(mergeSavedProfilesIntoDashboard(mergeSavedSettingsIntoDashboard(incomingDashboard)));
  if (options.sync) {
    const synced = await syncSavedProfilesToServer();
    if (synced?.dashboard) next = mergeSavedDocumentsIntoDashboard(mergeSavedProfilesIntoDashboard(mergeSavedSettingsIntoDashboard(synced.dashboard)));
    const syncedSettings = await syncSavedSettingsToServer();
    if (syncedSettings?.dashboard) next = mergeSavedDocumentsIntoDashboard(mergeSavedProfilesIntoDashboard(mergeSavedSettingsIntoDashboard(syncedSettings.dashboard)));
    const syncedDocuments = await syncSavedDocumentsToServer();
    if (syncedDocuments?.dashboard) next = mergeSavedDocumentsIntoDashboard(mergeSavedProfilesIntoDashboard(mergeSavedSettingsIntoDashboard(syncedDocuments.dashboard)));
  }
  const normalized = normalizeDashboardShape(next);
  saveProfilesSnapshot(normalized.students);
  saveSettingsSnapshot(normalized.settings);
  return normalized;
}

function normalizeDashboardShape(incomingDashboard) {
  return {
    ...incomingDashboard,
    submissionSessions: incomingDashboard.submissionSessions ?? [],
    latestInvites: incomingDashboard.latestInvites ?? []
  };
}

function profilePersistenceEnabled() {
  return Boolean(currentFamily?.id);
}

function profileStorageKey() {
  return `scholarship-agent:${currentFamily.id}:profiles:v${PROFILE_STORAGE_VERSION}`;
}

function loadSavedProfileSnapshot() {
  if (!profilePersistenceEnabled()) return null;
  try {
    const raw = localStorage.getItem(profileStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.students)) return null;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      students: parsed.students.filter(isPersistableStudent)
    };
  } catch {
    return null;
  }
}

function loadSavedProfiles() {
  return loadSavedProfileSnapshot()?.students ?? [];
}

function saveProfilesSnapshot(studentList) {
  if (!profilePersistenceEnabled()) return;
  const students = (studentList ?? []).filter(isPersistableStudent).map(serializeStudent);
  localStorage.setItem(
    profileStorageKey(),
    JSON.stringify({
      version: PROFILE_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      students
    })
  );
}

function saveProfilesFromDashboard() {
  saveProfilesSnapshot(dashboard?.students ?? []);
}

function settingsPersistenceEnabled() {
  return profilePersistenceEnabled();
}

function settingsStorageKey() {
  return `scholarship-agent:${currentFamily.id}:settings:v${SETTINGS_STORAGE_VERSION}`;
}

function loadSavedSettings() {
  if (!settingsPersistenceEnabled()) return null;
  try {
    const raw = localStorage.getItem(settingsStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPersistableSettings(parsed.settings) ? parsed.settings : null;
  } catch {
    return null;
  }
}

function saveSettingsSnapshot(settings) {
  if (!settingsPersistenceEnabled() || !isPersistableSettings(settings)) return;
  localStorage.setItem(
    settingsStorageKey(),
    JSON.stringify({
      version: SETTINGS_STORAGE_VERSION,
      updatedAt: settings.updatedAt ?? new Date().toISOString(),
      settings: cloneSettings(settings)
    })
  );
}

function saveSettingsFromDashboard() {
  saveSettingsSnapshot(dashboard?.settings);
}

function documentPersistenceEnabled() {
  return profilePersistenceEnabled();
}

function documentStorageKey() {
  return `scholarship-agent:${currentFamily.id}:documents:v${DOCUMENT_STORAGE_VERSION}`;
}

function loadSavedDocuments() {
  if (!documentPersistenceEnabled()) return [];
  try {
    const raw = localStorage.getItem(documentStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.documents) ? parsed.documents.filter(isPersistableDocument) : [];
  } catch {
    return [];
  }
}

function saveDocumentsFromDashboard() {
  if (!documentPersistenceEnabled()) return;
  const documents = (dashboard?.documents ?? []).filter(isPersistableDocument).map(serializeDocument);
  if (!documents.length) {
    localStorage.removeItem(documentStorageKey());
    return;
  }
  localStorage.setItem(
    documentStorageKey(),
    JSON.stringify({
      version: DOCUMENT_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      documents
    })
  );
}

async function syncSavedProfilesToServer() {
  const students = loadSavedProfiles();
  if (!students.length) return null;
  try {
    const response = await fetch("/api/students/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ students })
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function syncSavedDocumentsToServer() {
  const documents = loadSavedDocuments();
  if (!documents.length) return null;
  try {
    const response = await fetch("/api/documents/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents })
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function syncSavedSettingsToServer() {
  const settings = loadSavedSettings();
  if (!settings) return null;
  try {
    const response = await fetch("/api/settings/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings })
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function mergeSavedProfilesIntoDashboard(incomingDashboard) {
  if (!incomingDashboard || !profilePersistenceEnabled()) return incomingDashboard;
  const snapshot = loadSavedProfileSnapshot();
  if (!snapshot || !snapshot.students.length) return incomingDashboard;
  if (!shouldUseSavedProfiles(snapshot, incomingDashboard.students ?? [])) return incomingDashboard;
  return {
    ...incomingDashboard,
    students: snapshot.students
  };
}

function shouldUseSavedProfiles(snapshot, incomingStudents) {
  const incomingIds = new Set((incomingStudents ?? []).map((student) => student.id));
  if (snapshot.students.some((student) => !incomingIds.has(student.id))) return true;
  if (snapshot.students.length > (incomingStudents ?? []).length) return true;
  return false;
}

function mergeSavedSettingsIntoDashboard(incomingDashboard) {
  if (!incomingDashboard || !settingsPersistenceEnabled()) return incomingDashboard;
  const savedSettings = loadSavedSettings();
  if (!savedSettings) return incomingDashboard;
  const incomingSettings = incomingDashboard.settings ?? defaultSettings();
  if (!shouldUseSavedSettings(savedSettings, incomingSettings)) return incomingDashboard;
  return {
    ...incomingDashboard,
    settings: mergeRequiredAdminUsers(savedSettings, incomingSettings)
  };
}

function shouldUseSavedSettings(savedSettings, incomingSettings) {
  const savedTime = Date.parse(savedSettings.updatedAt ?? "");
  const incomingTime = Date.parse(incomingSettings?.updatedAt ?? "");
  const savedUsers = Array.isArray(savedSettings.users) ? savedSettings.users.length : 0;
  const incomingUsers = Array.isArray(incomingSettings?.users) ? incomingSettings.users.length : 0;
  if (Number.isFinite(savedTime) && (!Number.isFinite(incomingTime) || savedTime > incomingTime)) return true;
  if (savedUsers > incomingUsers && incomingUsers <= 1) return true;
  return false;
}

function mergeRequiredAdminUsers(savedSettings, incomingSettings) {
  const next = cloneSettings(savedSettings);
  const users = Array.isArray(next.users) ? next.users : [];
  const knownEmails = new Set(users.map((user) => String(user.email ?? "").toLowerCase()).filter(Boolean));
  for (const user of incomingSettings?.users ?? []) {
    if (user?.role !== "Admin") continue;
    const email = String(user.email ?? "").toLowerCase();
    if (!email || knownEmails.has(email)) continue;
    users.unshift(user);
    knownEmails.add(email);
  }
  next.users = users;
  return next;
}

function mergeSavedDocumentsIntoDashboard(incomingDashboard) {
  if (!incomingDashboard || !documentPersistenceEnabled()) return incomingDashboard;
  const savedDocuments = loadSavedDocuments();
  if (!savedDocuments.length) return incomingDashboard;
  return {
    ...incomingDashboard,
    documents: mergeDocuments(incomingDashboard.documents ?? [], savedDocuments)
  };
}

function mergeSavedStudentIntoDashboard(incomingDashboard, savedStudent) {
  const base = {
    ...(dashboard ?? incomingDashboard),
    ...incomingDashboard
  };
  const students = mergeStudents(dashboard?.students ?? [], incomingDashboard?.students ?? [], savedStudent ? [savedStudent] : []);
  return {
    ...base,
    students
  };
}

function mergeSavedDocumentIntoDashboard(incomingDashboard, savedDocument) {
  const base = {
    ...(dashboard ?? incomingDashboard),
    ...incomingDashboard
  };
  return {
    ...base,
    documents: mergeDocuments(dashboard?.documents ?? [], incomingDashboard?.documents ?? [], savedDocument ? [savedDocument] : [])
  };
}

function mergeStudents(...studentLists) {
  const byId = new Map();
  const order = [];
  for (const list of studentLists) {
    for (const student of list ?? []) {
      if (!isPersistableStudent(student)) continue;
      if (!byId.has(student.id)) order.push(student.id);
      byId.set(student.id, serializeStudent(student));
    }
  }
  return order.map((id) => byId.get(id));
}

function mergeDocuments(...documentLists) {
  const byId = new Map();
  const order = [];
  for (const list of documentLists) {
    for (const document of list ?? []) {
      if (!isPersistableDocument(document)) continue;
      if (!byId.has(document.id)) order.push(document.id);
      byId.set(document.id, serializeDocument(document));
    }
  }
  return order.map((id) => byId.get(id));
}

function serializeStudent(student) {
  return {
    id: student.id,
    familyId: student.familyId,
    name: student.name,
    graduationYear: student.graduationYear,
    schoolState: student.schoolState,
    profile: student.profile,
    createdAt: student.createdAt
  };
}

function serializeDocument(document) {
  return {
    id: document.id,
    familyId: document.familyId,
    studentId: document.studentId,
    type: document.type,
    name: document.name,
    path: document.path,
    status: document.status,
    uploadedAt: document.uploadedAt
  };
}

function isPersistableSettings(settings) {
  return Boolean(
    settings &&
      Array.isArray(settings.users) &&
      Array.isArray(settings.customBoxes) &&
      Array.isArray(settings.customFields) &&
      Array.isArray(settings.customTabs) &&
      settings.roleRights &&
      typeof settings.roleRights === "object"
  );
}

function isPersistableStudent(student) {
  return Boolean(
    student?.id &&
      student?.profile?.preferredName &&
      student?.profile?.legalName &&
      Number.isFinite(Number(student?.profile?.graduationYear)) &&
      student?.profile?.schoolState
  );
}

function isPersistableDocument(document) {
  return Boolean(
    document?.id &&
      document?.studentId &&
      ["resume", "transcript", "recommendation", "essay", "other"].includes(document?.type) &&
      document?.name &&
      document?.status
  );
}

function openDocumentDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("This browser cannot store uploaded files locally."));
      return;
    }
    const request = indexedDB.open(DOCUMENT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DOCUMENT_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open document storage."));
  });
}

async function saveDocumentFile(documentId, file) {
  const db = await openDocumentDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DOCUMENT_STORE_NAME, "readwrite");
    transaction.objectStore(DOCUMENT_STORE_NAME).put({
      id: documentId,
      name: file.name,
      type: file.type,
      size: file.size,
      updatedAt: new Date().toISOString(),
      file
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save document file."));
  });
  db.close();
}

async function deleteDocumentFile(documentId) {
  try {
    const db = await openDocumentDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DOCUMENT_STORE_NAME, "readwrite");
      transaction.objectStore(DOCUMENT_STORE_NAME).delete(documentId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete document file."));
    });
    db.close();
  } catch {
    // Metadata deletion should still work if the browser's file store is unavailable.
  }
}

function syncCustomNavTabs() {
  nav.querySelectorAll(".custom-nav").forEach((item) => item.remove());
  const settings = settingsData();
  for (const tab of settings.customTabs) {
    const button = document.createElement("button");
    button.className = "nav-item custom-nav";
    button.dataset.view = `custom-tab:${tab.id}`;
    button.type = "button";
    button.textContent = tab.label;
    nav.appendChild(button);
  }
}

function renderOverview() {
  const ready = dashboard.scholarships.filter((item) => item.status === "ready_for_review").length;
  const topMatches = topNoEssayScholarshipMatches();
  const applicationReviewQueue = activeApplicationReviewQueue();
  const pending = applicationReviewQueue.length;
  content.innerHTML = `
    <div class="metrics">
      ${metric("Students", dashboard.students.length)}
      ${metric("Matches", dashboard.scholarships.length)}
      ${metric("Ready", ready)}
      ${metric("Approvals", pending)}
    </div>
    <section class="panel portal-strip">
      <div>
        <h2>${escapeHtml(dashboard.family.name)}</h2>
        <p class="compact">Live portal updates are connected for ${escapeHtml(currentUser?.displayName ?? "Parent")}. Agent actions still require review before external side effects.</p>
      </div>
      <span id="liveBadge" class="pill low">live</span>
    </section>
    <div class="grid">
      <section class="panel">
        <h2>Top No-Essay Scholarship Matches</h2>
        <div class="list">
          ${topMatches.map(renderScholarshipItem).join("") || empty("No matches yet.")}
        </div>
      </section>
      <section class="panel">
        <h2>Application Review Queue</h2>
        <div class="list">
          ${applicationReviewQueue.map(renderApprovalItem).join("") || empty("No application reviews pending. Run No-Essay Search to refresh the queue.")}
        </div>
      </section>
    </div>
  `;
  wireApprovalButtons();
  wireApplyProfileSelectors();
  wireBrowserButtons();
  wireSubmissionButtons();
}

function topNoEssayScholarshipMatches() {
  return [...(dashboard.scholarships ?? [])]
    .filter((scholarship) => !scholarshipRequiresEssayClient(scholarship))
    .slice(0, TOP_REVIEW_MATCH_LIMIT);
}

function activeApplicationReviewQueue() {
  const topMatches = topNoEssayScholarshipMatches();
  const topRank = new Map(topMatches.map((scholarship, index) => [scholarship.id, index]));
  return [...(dashboard.approvals ?? [])]
    .filter((approval) => {
      if (approval.status !== "pending") return false;
      if (approval.actionType !== "portal_submit" || approval.targetType !== "application_plan") return false;
      const plan = dashboard.applicationPlans.find((candidate) => candidate.id === approval.targetId);
      return plan ? topRank.has(plan.scholarshipId) : false;
    })
    .sort((a, b) => {
      const aPlan = dashboard.applicationPlans.find((candidate) => candidate.id === a.targetId);
      const bPlan = dashboard.applicationPlans.find((candidate) => candidate.id === b.targetId);
      const aRank = topRank.get(aPlan?.scholarshipId) ?? Number.MAX_SAFE_INTEGER;
      const bRank = topRank.get(bPlan?.scholarshipId) ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? ""));
    });
}

function scholarshipRequiresEssayClient(scholarship) {
  return scholarship?.requirements?.some((requirement) => requirement.kind === "essay") ?? false;
}

function renderProfiles() {
  content.innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Profiles</h2>
          <p class="compact">Student details the agents can use for matching, drafting, and application prep.</p>
        </div>
        <button class="primary profile-add" type="button" data-add-profile>Add Profile</button>
      </div>
      <div class="list">
        ${dashboard.students.map(renderProfileItem).join("") || empty("No student profiles yet.")}
      </div>
    </section>
  `;
  wireProfileButtons();
}

function renderStudentFiles() {
  const totalDocuments = dashboard.documents.length;
  const transcriptCount = dashboard.documents.filter((document) => document.type === "transcript").length;
  const studentCount = dashboard.students.filter((student) => dashboard.documents.some((document) => document.studentId === student.id)).length;
  const selectedCategory = dashboard.students.some((student) => student.id === activeStudentFilesCategory) ? activeStudentFilesCategory : "all";
  activeStudentFilesCategory = selectedCategory;
  const selectedStudents =
    selectedCategory === "all" ? dashboard.students : dashboard.students.filter((student) => student.id === selectedCategory);
  content.innerHTML = `
    <div class="metrics file-metrics">
      ${metric("Files", totalDocuments)}
      ${metric("Students", studentCount)}
      ${metric("Transcripts", transcriptCount)}
      ${metric("File types", new Set(dashboard.documents.map((document) => document.type)).size)}
    </div>
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Students Files</h2>
          <p class="compact">Store transcripts, resumes, recommendations, essays, and other reusable documents by profile category.</p>
        </div>
        <button class="primary profile-add" type="button" data-add-profile>Add Profile</button>
      </div>
      <div class="student-file-categories" role="tablist" aria-label="Student file categories">
        ${renderStudentFileCategoryButton("all", "All profiles", totalDocuments, selectedCategory === "all")}
        ${dashboard.students.map((student) => renderStudentFileCategoryButton(student.id, student.profile.preferredName, dashboard.documents.filter((document) => document.studentId === student.id).length, selectedCategory === student.id)).join("")}
      </div>
      <div class="list">
        ${selectedStudents.map(renderStudentFilesItem).join("") || empty("No student profiles yet.")}
      </div>
    </section>
  `;
  wireStudentFileCategoryButtons();
  wireDocumentDeleteButtons();
  wireDocumentProfileSelectors();
  wireDocumentUploadForms();
}

function renderStudentFileCategoryButton(id, label, count, active) {
  return `
    <button class="file-category ${active ? "active" : ""}" type="button" data-student-category="${escapeHtml(id)}" role="tab" aria-selected="${active ? "true" : "false"}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(count)}</strong>
    </button>
  `;
}

function renderStudentFilesItem(student) {
  const documents = dashboard.documents.filter((document) => document.studentId === student.id);
  return `
    <article class="item student-file-card">
      <div class="item-head">
        <div class="item-title">
          <h3>${escapeHtml(student.profile.preferredName)}</h3>
          <p class="compact">Class of ${escapeHtml(student.profile.graduationYear)} · ${escapeHtml(student.profile.schoolState || "No state")} · ${documents.length} file${documents.length === 1 ? "" : "s"}</p>
        </div>
        <span class="pill ${documents.length ? "low" : "medium"}">${documents.length ? "files stored" : "no files yet"}</span>
      </div>
      ${renderStudentDocumentManager(student, "student-files")}
    </article>
  `;
}

function renderScholarships() {
  content.innerHTML = `
    <section class="panel">
      <h2>Scholarships</h2>
      <div class="list">
        ${dashboard.scholarships.map(renderScholarshipItem).join("") || empty("Run the no-essay search to find scholarships.")}
      </div>
    </section>
  `;
  wireBrowserButtons();
  wireSubmissionButtons();
}

function renderEssays() {
  content.innerHTML = `
    <section class="panel">
      <h2>Essay Drafts</h2>
      <div class="list">
        ${
          dashboard.essayDrafts
            .map((draft) => {
              const scholarship = dashboard.scholarships.find((item) => item.id === draft.scholarshipId);
              return `
                <article class="item">
                  <div class="item-head">
                    <div class="item-title">
                      <h3>${escapeHtml(scholarship?.title ?? "Scholarship")}</h3>
                      <p class="compact">${escapeHtml(draft.prompt)}</p>
                    </div>
                    <span class="pill pending">${escapeHtml(draft.status.replaceAll("_", " "))}</span>
                  </div>
                  <div class="essay">${escapeHtml(draft.draft)}</div>
                  <div class="tags">
                    ${
                      draft.unsupportedClaims.length
                        ? draft.unsupportedClaims.map((claim) => `<span class="pill high">${escapeHtml(claim)}</span>`).join("")
                        : `<span class="pill low">No unsupported claims flagged</span>`
                    }
                  </div>
                </article>
              `;
            })
            .join("") || empty("No essay drafts needed for no-essay scholarships.")
        }
      </div>
    </section>
  `;
}

function renderApprovals() {
  content.innerHTML = `
    <section class="panel">
      <h2>Approvals</h2>
      <div class="list">
        ${dashboard.approvals.map(renderApprovalItem).join("") || empty("No approval records yet.")}
      </div>
    </section>
  `;
  wireApprovalButtons();
  wireApplyProfileSelectors();
  wireSubmissionButtons();
}

function renderAudit() {
  content.innerHTML = `
    <section class="panel">
      <h2>Audit Trail</h2>
      <div class="audit">
        ${
          dashboard.auditEvents
            .map(
              (event) => `
                <div class="audit-row">
                  <strong>${escapeHtml(event.eventType.replaceAll("_", " "))}</strong>
                  <span>${escapeHtml(event.actor)} · ${escapeHtml(event.targetType)}</span>
                  <span class="muted">${formatDate(event.createdAt)}</span>
                </div>
              `
            )
            .join("") || empty("No audit events yet.")
        }
      </div>
    </section>
  `;
}

function renderSettings() {
  const settings = settingsData();
  content.innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Settings</h2>
          <p class="compact">Customize portal users, rights, fields, boxes, and tabs for your family workflow.</p>
        </div>
        <span class="pill low">Admin controlled</span>
      </div>
      <div class="settings-layout">
        ${renderSharePortalCard()}

        <section class="settings-card">
          <h3>Invite New User</h3>
          <p class="compact">Send a portal invite, assign a role, and choose which Profiles this user can access.</p>
          <form class="settings-form settings-user-form">
            <input name="name" placeholder="Name" required />
            <input name="email" type="email" placeholder="Email" required />
            <select name="role">
              ${SETTINGS_ROLES.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(roleLabel(role))}</option>`).join("")}
            </select>
            <fieldset class="settings-profile-field">
              <legend>Profile access</legend>
              <div class="settings-profile-checklist" data-profile-access>
                ${renderProfileCheckboxes([], "profileIds")}
              </div>
            </fieldset>
            <p class="compact">Admins automatically get every Profile. Other roles must be assigned at least one Profile.</p>
            <button class="primary" type="submit">Send Invite</button>
          </form>
          ${renderInviteResults()}
          <h3>Users</h3>
          <div class="settings-list">
            ${settings.users.map(renderSettingsUser).join("") || empty("No users configured yet.")}
          </div>
        </section>

        <section class="settings-card">
          <h3>Role Rights</h3>
          <p class="compact">Admin-only rights stay locked to Admin. Contributor, Guest, and Viewer cannot receive settings or user-management rights.</p>
          ${renderRightsMatrix(settings)}
        </section>

        <section class="settings-card">
          <h3>Custom Boxes</h3>
          <p class="compact">Create reusable information boxes for notes, reminders, or family-specific application rules.</p>
          <form class="settings-form settings-box-form">
            <input name="title" placeholder="Box title" required />
            <textarea name="content" rows="3" placeholder="Box content"></textarea>
            <button class="primary" type="submit">Add Box</button>
          </form>
          <div class="settings-list">
            ${settings.customBoxes.map((box) => renderSettingsRecord("customBoxes", box.id, box.title, box.content)).join("") || empty("No custom boxes yet.")}
          </div>
        </section>

        <section class="settings-card">
          <h3>Custom Fields</h3>
          <p class="compact">Define extra fields you want to track for profiles, scholarships, applications, documents, or approvals.</p>
          <form class="settings-form settings-field-form">
            <input name="label" placeholder="Field label" required />
            <select name="appliesTo">
              ${CUSTOM_FIELD_TARGETS.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}
            </select>
            <select name="type">
              ${CUSTOM_FIELD_TYPES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}
            </select>
            <button class="primary" type="submit">Add Field</button>
          </form>
          <div class="settings-list">
            ${
              settings.customFields
                .map((field) => renderSettingsRecord("customFields", field.id, field.label, `${labelFor(CUSTOM_FIELD_TARGETS, field.appliesTo)} · ${labelFor(CUSTOM_FIELD_TYPES, field.type)}`))
                .join("") || empty("No custom fields yet.")
            }
          </div>
        </section>

        <section class="settings-card">
          <h3>Custom Tabs</h3>
          <p class="compact">Add sidebar tabs for extra views like Documents, Fees, Deadlines, or school-specific checklists.</p>
          <form class="settings-form settings-tab-form">
            <input name="label" placeholder="Tab name" required />
            <textarea name="description" rows="3" placeholder="What this tab is for"></textarea>
            <button class="primary" type="submit">Add Tab</button>
          </form>
          <div class="settings-list">
            ${settings.customTabs.map((tab) => renderSettingsRecord("customTabs", tab.id, tab.label, tab.description || "Custom sidebar tab")).join("") || empty("No custom tabs yet.")}
          </div>
        </section>
      </div>
    </section>
  `;
  wireSettingsForms();
}

function renderSharePortalCard() {
  const appUrl = portalShareBaseUrl();
  const loginUrl = `${appUrl}/login?next=/portal.html`;
  const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(?::|$)/.test(window.location.host);
  return `
    <section class="settings-card share-card">
      <div class="section-head">
        <div>
          <h3>Share App Access</h3>
          <p class="compact">Invite an Admin below for full access to Profiles, Student Files, Approvals, and Settings.</p>
        </div>
        <span class="pill ${isLocal ? "medium" : "low"}">${isLocal ? "Local URL" : "IIS URL"}</span>
      </div>
      <div class="share-link-box">
        <span>Website</span>
        <strong>${escapeHtml(appUrl)}</strong>
        <button class="ghost share-copy" type="button" data-copy-value="${escapeHtml(appUrl)}" data-copy-label="website URL">Copy</button>
      </div>
      <div class="share-link-box">
        <span>Login</span>
        <strong>${escapeHtml(loginUrl)}</strong>
        <button class="ghost share-copy" type="button" data-copy-value="${escapeHtml(loginUrl)}" data-copy-label="login URL">Copy</button>
      </div>
      <p class="compact">${isLocal ? "This is a local address. For IIS sharing, open the public IIS website and create the invite there." : "Invite links created here will use this website domain."}</p>
    </section>
  `;
}

function renderCustomTab(tabId) {
  const settings = settingsData();
  const tab = settings.customTabs.find((item) => item.id === tabId);
  if (!tab) {
    activeView = "settings";
    return renderSettings();
  }
  content.innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(tab.label)}</h2>
          <p class="compact">${escapeHtml(tab.description || "Custom workspace tab")}</p>
        </div>
        <button class="ghost go-settings" type="button">Edit in Settings</button>
      </div>
      <div class="settings-layout">
        <section class="settings-card">
          <h3>Boxes</h3>
          <div class="settings-list">
            ${settings.customBoxes.map((box) => renderReadOnlySetting(box.title, box.content || "No details added yet.")).join("") || empty("Add boxes in Settings to show them here.")}
          </div>
        </section>
        <section class="settings-card">
          <h3>Fields</h3>
          <div class="settings-list">
            ${
              settings.customFields
                .map((field) => renderReadOnlySetting(field.label, `${labelFor(CUSTOM_FIELD_TARGETS, field.appliesTo)} · ${labelFor(CUSTOM_FIELD_TYPES, field.type)}`))
                .join("") || empty("Add fields in Settings to show them here.")
            }
          </div>
        </section>
      </div>
    </section>
  `;
  document.querySelector(".go-settings")?.addEventListener("click", () => {
    activeView = "settings";
    setActiveNav(activeView);
    render();
  });
}

function renderSettingsUser(user) {
  return `
    <article class="setting-row settings-user-row">
      <div>
        <strong>${escapeHtml(user.name)}</strong>
        <p class="compact">${escapeHtml(user.email)} · ${escapeHtml(roleDescription(user.role))}</p>
        <p class="compact">Profile access: ${escapeHtml(profileAccessSummary(user))}</p>
      </div>
      <div class="setting-controls">
        ${renderSettingsUserProfileControl(user)}
        <select class="settings-user-role" data-user="${escapeHtml(user.id)}">
          ${SETTINGS_ROLES.map((role) => `<option value="${escapeHtml(role)}" ${role === user.role ? "selected" : ""}>${escapeHtml(roleLabel(role))}</option>`).join("")}
        </select>
        <select class="settings-user-status" data-user="${escapeHtml(user.id)}">
          <option value="active" ${user.status === "active" ? "selected" : ""}>Active</option>
          <option value="inactive" ${user.status === "inactive" ? "selected" : ""}>Inactive</option>
        </select>
        <button class="ghost settings-invite" type="button" data-user="${escapeHtml(user.id)}">Send Invite</button>
        <button class="ghost settings-delete" type="button" data-collection="users" data-id="${escapeHtml(user.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderInviteResults() {
  const invites = currentInviteResults();
  if (!invites.length) return "";
  return `
    <div class="invite-results">
      <strong>Latest Invite</strong>
      ${invites.map((invite) => `
        <article class="invite-result">
          <span>${escapeHtml(invite.email)} · ${escapeHtml(inviteStatusLabel(invite.status))}</span>
          ${invite.error ? `<p class="invite-error">${escapeHtml(invite.error)}</p>` : ""}
          ${renderInviteResultActions(invite)}
        </article>
      `).join("")}
    </div>
  `;
}

function currentInviteResults() {
  return Array.isArray(dashboard?.latestInvites) && dashboard.latestInvites.length
    ? dashboard.latestInvites
    : latestInviteResults;
}

function renderInviteResultActions(invite) {
  if (!invite.inviteUrl) return "";
  return `
    <div class="invite-result-actions">
      <a href="${escapeHtml(invite.inviteUrl)}" target="_blank" rel="noreferrer">Open invite link</a>
      <a href="${escapeHtml(inviteMailtoHref(invite))}">Open email draft</a>
    </div>
  `;
}

function inviteMailtoHref(invite) {
  const subject = encodeURIComponent("Scholarship Agent portal invite");
  const body = encodeURIComponent([
    "You have been invited to the Scholarship Agent portal.",
    "",
    "Use this secure link to create your password and sign in:",
    invite.inviteUrl
  ].join("\n"));
  return `mailto:${encodeURIComponent(invite.email)}?subject=${subject}&body=${body}`;
}

function inviteStatusLabel(status) {
  if (status === "manual") return "Manual invite ready";
  if (status === "sent") return "Email sent";
  if (status === "not_configured") return "Email not configured";
  if (status === "accepted") return "Invite accepted";
  if (status === "expired") return "Invite expired";
  return "Email failed";
}

function renderSettingsUserProfileControl(user) {
  if (user.role === "Admin") {
    return `<span class="settings-profile-all">All Profiles</span>`;
  }
  return `
    <div
      class="settings-user-profile-list"
      data-user="${escapeHtml(user.id)}"
    >
      ${renderProfileCheckboxes(user.profileIds ?? [], `profileIds-${user.id}`, "settings-user-profile-checkbox")}
    </div>
  `;
}

function renderSettingsRecord(collection, id, title, detail) {
  return `
    <article class="setting-row">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p class="compact">${escapeHtml(detail || "No details added yet.")}</p>
      </div>
      <button class="ghost settings-delete" type="button" data-collection="${escapeHtml(collection)}" data-id="${escapeHtml(id)}">Remove</button>
    </article>
  `;
}

function renderReadOnlySetting(title, detail) {
  return `
    <article class="setting-row">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p class="compact">${escapeHtml(detail)}</p>
      </div>
    </article>
  `;
}

function renderRightsMatrix(settings) {
  return `
    <div class="rights-table">
      <div class="rights-head">Role</div>
      ${SETTINGS_CAPABILITIES.map(([, label]) => `<div class="rights-head">${escapeHtml(label)}</div>`).join("")}
      ${SETTINGS_ROLES.map((role) => renderRightsRow(role, settings.roleRights[role])).join("")}
    </div>
  `;
}

function renderRightsRow(role, rights) {
  return `
    <div class="rights-role">
      <strong>${escapeHtml(roleLabel(role))}</strong>
      <span>${escapeHtml(roleDescription(role))}</span>
    </div>
    ${SETTINGS_CAPABILITIES.map(([capability]) => renderCapabilityToggle(role, capability, Boolean(rights?.[capability]))).join("")}
  `;
}

function renderCapabilityToggle(role, capability, checked) {
  const adminCapability = capability === "manageSettings" || capability === "manageUsers";
  const locked = adminCapability;
  const isChecked = role === "Admin" && adminCapability ? true : checked;
  return `
    <label class="right-cell" title="${locked && role !== "Admin" ? "Admin-only capability" : ""}">
      <input
        class="right-toggle"
        type="checkbox"
        data-role="${escapeHtml(role)}"
        data-capability="${escapeHtml(capability)}"
        ${isChecked ? "checked" : ""}
        ${locked ? "disabled" : ""}
      />
    </label>
  `;
}

function wireSettingsForms() {
  const userForm = document.querySelector(".settings-user-form");
  const userRoleSelect = userForm?.querySelector('select[name="role"]');
  const userProfileList = userForm?.querySelector("[data-profile-access]");
  const syncUserProfileRequirement = () => {
    if (!userRoleSelect || !userProfileList) return;
    const needsAssignment = userRoleSelect.value !== "Admin";
    userProfileList.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.disabled = !needsAssignment;
      if (!needsAssignment) checkbox.checked = false;
    });
    if (!needsAssignment) {
      userProfileList.classList.add("is-disabled");
    } else {
      userProfileList.classList.remove("is-disabled");
    }
  };
  userRoleSelect?.addEventListener("change", syncUserProfileRequirement);
  syncUserProfileRequirement();

  document.querySelector(".settings-user-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const role = String(formData.get("role") ?? "Viewer");
    const profileIds = role === "Admin" ? [] : selectedProfileIds(form.querySelector("[data-profile-access]"));
    if (role !== "Admin" && !profileIds.length) {
      setStatus("Choose at least one Profile for non-admin users.");
      form.querySelector('[name="profileIds"]')?.focus();
      return;
    }
    await saveSettings((settings) => {
      settings.users.push({
        id: randomId("user"),
        name: String(formData.get("name") ?? "").trim(),
        email: String(formData.get("email") ?? "").trim().toLowerCase(),
        role,
        status: "active",
        profileAccess: role === "Admin" ? "all" : "assigned",
        profileIds
      });
    }, "Invite created.");
  });

  document.querySelector(".settings-box-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    await saveSettings((settings) => {
      settings.customBoxes.push({
        id: randomId("box"),
        title: String(formData.get("title") ?? "").trim(),
        content: String(formData.get("content") ?? "").trim()
      });
    }, "Custom box added.");
  });

  document.querySelector(".settings-field-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    await saveSettings((settings) => {
      settings.customFields.push({
        id: randomId("field"),
        label: String(formData.get("label") ?? "").trim(),
        appliesTo: String(formData.get("appliesTo") ?? "student_profile"),
        type: String(formData.get("type") ?? "text")
      });
    }, "Custom field added.");
  });

  document.querySelector(".settings-tab-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    await saveSettings((settings) => {
      settings.customTabs.push({
        id: randomId("tab"),
        label: String(formData.get("label") ?? "").trim(),
        description: String(formData.get("description") ?? "").trim()
      });
    }, "Custom tab added.");
  });

  document.querySelectorAll(".settings-delete").forEach((button) => {
    button.addEventListener("click", async () => {
      await saveSettings((settings) => {
        const collection = button.dataset.collection;
        if (!Array.isArray(settings[collection])) return;
        settings[collection] = settings[collection].filter((item) => item.id !== button.dataset.id);
        if (activeView === `custom-tab:${button.dataset.id}`) activeView = "settings";
      }, "Settings item removed.");
    });
  });

  document.querySelectorAll(".settings-invite").forEach((button) => {
    button.addEventListener("click", async () => {
      await sendSettingsInvite(button.dataset.user);
    });
  });

  document.querySelectorAll(".share-copy").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyShareValue(button.dataset.copyValue, button.dataset.copyLabel);
    });
  });

  document.querySelectorAll(".settings-user-role").forEach((select) => {
    select.addEventListener("change", async () => {
      await saveSettings((settings) => {
        const user = settings.users.find((item) => item.id === select.dataset.user);
        if (!user) return;
        user.role = select.value;
        if (user.role === "Admin") {
          user.profileAccess = "all";
          user.profileIds = [];
        } else {
          user.profileAccess = "assigned";
          user.profileIds = Array.isArray(user.profileIds) ? user.profileIds : [];
          if (!user.profileIds.length && dashboard.students[0]) user.profileIds = [dashboard.students[0].id];
        }
      }, "User role updated.");
    });
  });

  document.querySelectorAll(".settings-user-profile-list").forEach((list) => {
    list.addEventListener("change", async () => {
      const profileIds = selectedProfileIds(list);
      if (!profileIds.length) {
        setStatus("Choose at least one Profile for non-admin users.");
        render();
        return;
      }
      await saveSettings((settings) => {
        const user = settings.users.find((item) => item.id === list.dataset.user);
        if (!user || user.role === "Admin") return;
        user.profileAccess = "assigned";
        user.profileIds = profileIds;
      }, "User Profile access updated.");
    });
  });

  document.querySelectorAll(".settings-user-status").forEach((select) => {
    select.addEventListener("change", async () => {
      await saveSettings((settings) => {
        const user = settings.users.find((item) => item.id === select.dataset.user);
        if (user) user.status = select.value;
      }, "User status updated.");
    });
  });

  document.querySelectorAll(".right-toggle").forEach((toggle) => {
    toggle.addEventListener("change", async () => {
      await saveSettings((settings) => {
        const role = toggle.dataset.role;
        const capability = toggle.dataset.capability;
        if (!settings.roleRights[role]) return;
        settings.roleRights[role][capability] = toggle.checked;
      }, "Role rights updated.");
    });
  });
}

async function sendSettingsInvite(userId) {
  if (!userId) return;
  await withStatus("Creating invite link...", async () => {
    const response = await fetch(`/api/settings/users/${encodeURIComponent(userId)}/invite`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not create invite.");
    if (payload.dashboard) dashboard = await hydrateDashboard(payload.dashboard);
    latestInviteResults = Array.isArray(dashboard?.latestInvites) && dashboard.latestInvites.length
      ? dashboard.latestInvites
      : payload.invite ? [payload.invite] : latestInviteResults;
    setStatus(settingsInviteStatus(latestInviteResults) || "Invite link created.");
    render();
  });
}

async function saveSettings(mutator, successMessage) {
  const next = cloneSettings(settingsData());
  mutator(next);
  next.updatedAt = new Date().toISOString();

  await withStatus("Saving settings...", async () => {
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not save settings.");
    saveSettingsSnapshot(payload.settings ?? next);
    dashboard = await hydrateDashboard(payload.dashboard);
    latestInviteResults = Array.isArray(payload.invites) && payload.invites.length
      ? payload.invites
      : Array.isArray(dashboard?.latestInvites) ? dashboard.latestInvites : latestInviteResults;
    setStatus(settingsInviteStatus(payload.invites) || successMessage);
    render();
  });
}

function settingsInviteStatus(invites) {
  if (!Array.isArray(invites) || !invites.length) return "";
  const sent = invites.filter((invite) => invite.status === "sent").length;
  const failed = invites.filter((invite) => invite.status === "failed").length;
  const notConfigured = invites.filter((invite) => invite.status === "not_configured").length;
  const manual = invites.filter((invite) => invite.status === "manual").length;
  const accepted = invites.filter((invite) => invite.status === "accepted").length;
  const expired = invites.filter((invite) => invite.status === "expired").length;
  const invited = invites.map((invite) => invite.email).join(", ");
  const firstError = invites.find((invite) => invite.error)?.error;
  if (manual && manual === invites.length) return `Manual invite ready for ${invited}.`;
  if (sent && sent === invites.length) return `Invite email sent to ${invited}.`;
  if (accepted && accepted === invites.length) return `Invite accepted by ${invited}.`;
  if (expired && expired === invites.length) return `Invite expired for ${invited}.`;
  if (sent) return `Invite email sent to ${sent} user${sent === 1 ? "" : "s"}; ${failed + notConfigured} invite${failed + notConfigured === 1 ? "" : "s"} need email setup.`;
  if (notConfigured) return `Invite created for ${invited}. Add RESEND_API_KEY in Vercel to send emails automatically.`;
  return firstError ? `Invite email could not be sent to ${invited}: ${firstError}` : `Invite email could not be sent to ${invited}.`;
}

function renderProfileItem(student) {
  const profile = normalizeProfileForUi(student.profile);
  return `
    <article class="item profile-card">
      <div class="item-head">
        <div class="item-title">
          <h3>${escapeHtml(profile.preferredName)} ${profile.legalName !== profile.preferredName ? `<span class="muted">(${escapeHtml(profile.legalName)})</span>` : ""}</h3>
          <p class="compact">${escapeHtml(titleCase(profile.gradeLevel))} · Class of ${escapeHtml(profile.graduationYear)} · ${escapeHtml(profile.schoolState)} · ${escapeHtml(profile.email || "Email required")}</p>
        </div>
        <div class="profile-actions">
          <span class="pill pending">${escapeHtml(student.name)}</span>
          <button class="ghost profile-edit" type="button" data-student="${student.id}">Edit</button>
          <button class="danger profile-delete" type="button" data-student="${student.id}">Remove</button>
        </div>
      </div>

      <div class="profile-facts">
        ${profileFact("First name", profile.firstName || firstNameFromLegalName(profile.legalName || profile.preferredName) || "Unknown")}
        ${profileFact("Last name", profile.lastName || lastNameFromLegalName(profile.legalName) || "Unknown")}
        ${profileFact("Gender", profile.gender || "Unknown")}
        ${profileFact("Date of birth", profile.dateOfBirth || "Unknown")}
        ${profileFact("Grad month", profile.graduationMonth || "Unknown")}
        ${profileFact("High school", profile.highSchoolName || "Unknown")}
        ${profileFact("GPA", profile.gpa ?? "Unknown")}
        ${profileFact("Citizenship", titleCase(profile.citizenship.replaceAll("_", " ")))}
        ${profileFact("First generation", formatYesNo(profile.firstGeneration))}
        ${profileFact("Financial need", titleCase(profile.financialNeed ?? "unknown"))}
        ${profileFact("Service hours", profile.serviceHours ?? "Unknown")}
      </div>

      ${profileTagGroup("Intended majors", profile.intendedMajors)}
      ${profileTagGroup("Colleges considering", profile.collegesConsidering ?? [])}
      ${profileTagGroup("Activities", profile.activities)}
      ${profileTagGroup("Awards", profile.awards)}
      ${profileTagGroup("Constraints", profile.constraints, "medium")}

      <div class="profile-notes">
        ${profileNote("Proud moment", profile.essayInterview.proudMoment)}
        ${profileNote("Community impact", profile.essayInterview.communityImpact)}
        ${profileNote("Challenge", profile.essayInterview.challenge)}
        ${profileNote("Future goal", profile.essayInterview.futureGoal)}
        ${profileNote("Voice notes", profile.essayInterview.voiceNotes)}
      </div>

      ${renderStudentDocumentManager(student, "profile")}
    </article>
  `;
}

function wireProfileButtons() {
  document.querySelectorAll(".profile-edit").forEach((button) => {
    button.addEventListener("click", () => {
      const student = dashboard.students.find((item) => item.id === button.dataset.student);
      if (student) openProfileEditor(student);
    });
  });
  document.querySelectorAll(".profile-delete").forEach((button) => {
    button.addEventListener("click", async () => {
      await removeStudentProfile(button.dataset.student);
    });
  });
  wireDocumentDeleteButtons();
  wireDocumentUploadForms();
}

async function removeStudentProfile(studentId) {
  const student = dashboard.students.find((item) => item.id === studentId);
  if (!student) return;
  if (dashboard.students.length <= 1) {
    setStatus("Add another Profile before removing this one.");
    return;
  }
  const name = student.profile?.preferredName || student.name || "this Profile";
  if (!window.confirm(`Remove ${name}? Linked documents and application prep for this Profile will be removed too.`)) return;
  await withStatus(`Removing ${name}...`, async () => {
    const response = await fetch(`/api/students/${encodeURIComponent(student.id)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not remove Profile.");
    saveProfilesSnapshot(payload.dashboard?.students ?? dashboard.students.filter((item) => item.id !== student.id));
    dashboard = await hydrateDashboard(payload.dashboard);
    saveDocumentsFromDashboard();
    setStatus(`${name} removed.`);
    render();
  });
}

function renderProfileDocument(documentRecord) {
  const tone = documentRecord.status === "available" ? "low" : "medium";
  const label = `${titleCase(documentRecord.type)} · ${documentRecord.name}`;
  return `
    <span class="pill document-pill ${tone}">
      <span>${escapeHtml(label)}</span>
      <button class="document-remove" type="button" data-document="${escapeHtml(documentRecord.id)}" aria-label="Remove ${escapeHtml(label)}">Remove</button>
    </span>
  `;
}

function renderStudentFileDocument(documentRecord) {
  const assignedStudent = dashboard.students.find((student) => student.id === documentRecord.studentId);
  return `
    <div class="student-file-document">
      <div class="student-file-main">
        <strong>${escapeHtml(documentRecord.name)}</strong>
        <span>${escapeHtml(titleCase(documentRecord.type))} · ${escapeHtml(documentRecord.status.replaceAll("_", " "))}</span>
      </div>
      <label class="document-profile-link">
        Profile
        <select class="document-profile-select" data-document="${escapeHtml(documentRecord.id)}" aria-label="Profile for ${escapeHtml(documentRecord.name)}">
          ${dashboard.students.map((student) => `<option value="${escapeHtml(student.id)}" ${student.id === documentRecord.studentId ? "selected" : ""}>${escapeHtml(student.profile.preferredName)}</option>`).join("")}
        </select>
      </label>
      <span class="pill low">${escapeHtml(assignedStudent?.profile.preferredName ?? "Unmatched")}</span>
      <button class="document-remove" type="button" data-document="${escapeHtml(documentRecord.id)}" aria-label="Remove ${escapeHtml(documentRecord.name)}">Remove</button>
    </div>
  `;
}

function renderStudentDocumentManager(student, context) {
  const documents = dashboard.documents.filter((document) => document.studentId === student.id);
  const fileInputId = `${context}-document-file-${student.id}`;
  const documentListClass = context === "student-files" ? "student-file-document-list" : "document-list";
  const documentMarkup = documents.length
    ? documents.map((documentRecord) => (context === "student-files" ? renderStudentFileDocument(documentRecord) : renderProfileDocument(documentRecord))).join("")
    : `<span class="pill medium">No documents linked yet</span>`;
  return `
    <div class="profile-documents">
      <strong>Documents</strong>
      <div class="${documentListClass}">
        ${documentMarkup}
      </div>
      <form class="document-upload-form" data-student="${escapeHtml(student.id)}">
        <select name="type" aria-label="Document type">
          ${DOCUMENT_TYPES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}
        </select>
        <div class="document-dropzone" data-dropzone>
          <input id="${escapeHtml(fileInputId)}" class="document-file-input" name="file" type="file" accept="${DOCUMENT_FILE_ACCEPT}" aria-label="Choose document file" />
          <label class="ghost document-file-button" for="${escapeHtml(fileInputId)}">Choose File</label>
          <span class="document-file-name" data-file-name aria-live="polite">No file selected. Drag and drop a file here.</span>
        </div>
        <button class="ghost" type="submit">Upload Document</button>
      </form>
      <p class="compact">Transcripts marked available are used by application prep when a scholarship requires one.</p>
    </div>
  `;
}

function wireStudentFileCategoryButtons() {
  document.querySelectorAll(".file-category").forEach((button) => {
    button.addEventListener("click", () => {
      activeStudentFilesCategory = button.dataset.studentCategory ?? "all";
      render();
    });
  });
}

function wireDocumentProfileSelectors() {
  document.querySelectorAll(".document-profile-select").forEach((select) => {
    select.addEventListener("change", async () => {
      const documentRecord = dashboard.documents.find((item) => item.id === select.dataset.document);
      const targetStudent = dashboard.students.find((item) => item.id === select.value);
      if (!documentRecord || !targetStudent) {
        setStatus("Choose a valid student profile for this file.");
        render();
        return;
      }
      if (documentRecord.studentId === targetStudent.id) return;
      await withStatus(`Moving ${documentRecord.name} to ${targetStudent.profile.preferredName}...`, async () => {
        const previousDashboard = dashboard;
        dashboard = {
          ...dashboard,
          documents: dashboard.documents.map((item) => (item.id === documentRecord.id ? { ...item, studentId: targetStudent.id } : item))
        };
        saveDocumentsFromDashboard();
        const response = await fetch(`/api/documents/${encodeURIComponent(documentRecord.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId: targetStudent.id })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          dashboard = previousDashboard;
          saveDocumentsFromDashboard();
          throw new Error(payload.error || "Could not update this file's profile.");
        }
        dashboard = payload.dashboard ?? dashboard;
        saveDocumentsFromDashboard();
        await syncSavedDocumentsToServer();
        activeStudentFilesCategory = targetStudent.id;
        setStatus(`${documentRecord.name} is now linked to ${targetStudent.profile.preferredName}.`);
        render();
      });
    });
  });
}

function wireDocumentDeleteButtons() {
  document.querySelectorAll(".document-remove").forEach((button) => {
    button.addEventListener("click", async () => {
      const documentRecord = dashboard.documents.find((item) => item.id === button.dataset.document);
      if (!documentRecord) {
        setStatus("Document was not found.");
        return;
      }
      const student = dashboard.students.find((item) => item.id === documentRecord.studentId);
      await withStatus(`Removing ${documentRecord.name}...`, async () => {
        const previousDashboard = dashboard;
        dashboard = { ...dashboard, documents: dashboard.documents.filter((item) => item.id !== documentRecord.id) };
        saveDocumentsFromDashboard();
        const response = await fetch(`/api/documents/${encodeURIComponent(documentRecord.id)}`, { method: "DELETE" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 404) {
          dashboard = previousDashboard;
          saveDocumentsFromDashboard();
          throw new Error(payload.error || "Could not remove document.");
        }
        const serverDashboard = payload.dashboard ?? dashboard;
        dashboard = { ...serverDashboard, documents: (serverDashboard.documents ?? []).filter((item) => item.id !== documentRecord.id) };
        await deleteDocumentFile(documentRecord.id);
        saveDocumentsFromDashboard();
        await syncSavedDocumentsToServer();
        setStatus(`${documentRecord.name} removed${student ? ` from ${student.profile.preferredName}` : ""}.`);
        render();
      });
    });
  });
}

function wireDocumentUploadForms() {
  document.querySelectorAll(".document-upload-form").forEach((form) => {
    const fileInput = form.querySelector('input[name="file"]');
    const dropzone = form.querySelector("[data-dropzone]");
    const fileName = form.querySelector("[data-file-name]");
    let selectedFile = null;

    const setSelectedFile = (file) => {
      selectedFile = file;
      if (fileName) {
        fileName.textContent = file ? `${file.name} (${formatFileSize(file.size)})` : "No file selected. Drag and drop a file here.";
      }
      dropzone?.classList.toggle("has-file", Boolean(file));
    };

    fileInput?.addEventListener("change", () => {
      setSelectedFile(fileInput.files?.[0] ?? null);
    });

    dropzone?.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragover");
    });

    dropzone?.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("is-dragover");
    });

    dropzone?.addEventListener("dragleave", () => {
      dropzone.classList.remove("is-dragover");
    });

    dropzone?.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragover");
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!isAcceptedDocumentFile(file)) {
        setStatus("Use a PDF, Word document, JPG, or PNG file.");
        return;
      }
      setSelectedFile(file);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = selectedFile ?? fileInput?.files?.[0];
      const type = form.querySelector('select[name="type"]')?.value ?? "other";
      const student = dashboard.students.find((item) => item.id === form.dataset.student);
      if (!student) {
        setStatus("Student profile was not found.");
        return;
      }
      if (!file) {
        setStatus("Choose a document file first.");
        return;
      }
      if (!isAcceptedDocumentFile(file)) {
        setStatus("Use a PDF, Word document, JPG, or PNG file.");
        return;
      }
      const documentId = randomId("doc");
      const documentRecord = {
        id: documentId,
        familyId: dashboard.family.id,
        studentId: student.id,
        type,
        name: file.name,
        path: `browser-local://${documentId}/${file.name}`,
        status: "available",
        uploadedAt: new Date().toISOString()
      };

      await withStatus(`Uploading ${file.name} for ${student.profile.preferredName}...`, async () => {
        await saveDocumentFile(documentId, file);
        const response = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(documentRecord)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not save document.");
        dashboard = mergeSavedDocumentIntoDashboard(payload.dashboard, payload.document);
        saveDocumentsFromDashboard();
        await syncSavedDocumentsToServer();
        setStatus(`${titleCase(type)} uploaded for ${student.profile.preferredName}.`);
        render();
      });
    });
  });
}

function openProfileEditor(student) {
  const profile = normalizeProfileForUi(student?.profile);
  profileEditor.hidden = false;
  profileEditor.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="profileEditorTitle">
      <div class="modal-head">
        <div>
          <h2 id="profileEditorTitle">${student ? "Edit Profile" : "Add Profile"}</h2>
          <p class="compact">Keep fields factual. Blank or unknown details become review tasks later.</p>
        </div>
        <button class="ghost profile-cancel" type="button">Close</button>
      </div>
      <form class="profile-form" novalidate>
        <div class="form-grid">
          ${textField("preferredName", "Preferred name", profile.preferredName, true)}
          ${textField("legalName", "Legal name", profile.legalName, true)}
          ${textField("firstName", "First name for applications", profile.firstName || firstNameFromLegalName(profile.legalName || profile.preferredName), true)}
          ${textField("lastName", "Last name for applications", profile.lastName || lastNameFromLegalName(profile.legalName))}
          ${emailField("email", "Student email", profile.email, true)}
          ${selectField("gender", "Gender", profile.gender ?? "", [
            ["", "Unknown"],
            ["Female", "Female"],
            ["Male", "Male"],
            ["Non-binary", "Non-binary"],
            ["Prefer not to answer", "Prefer not to answer"],
            ["Other", "Other"]
          ])}
          ${dateField("dateOfBirth", "Date of birth", profile.dateOfBirth ?? "")}
          ${numberField("graduationYear", "Graduation year", profile.graduationYear, true)}
          ${selectField("graduationMonth", "Graduation month", profile.graduationMonth ?? "June", MONTH_OPTIONS)}
          ${selectField("gradeLevel", "Grade level", profile.gradeLevel, [
            ["freshman", "Freshman"],
            ["sophomore", "Sophomore"],
            ["junior", "Junior"],
            ["senior", "Senior"]
          ])}
          ${textField("schoolState", "School state", profile.schoolState, true)}
          ${textField("highSchoolName", "High school name", profile.highSchoolName ?? "")}
          ${numberField("gpa", "GPA", profile.gpa ?? "", false, "0.01")}
          ${selectField("citizenship", "Citizenship", profile.citizenship, [
            ["unknown", "Unknown"],
            ["us_citizen", "U.S. citizen"],
            ["permanent_resident", "Permanent resident"],
            ["other", "Other"]
          ])}
          ${selectField("firstGeneration", "First generation", formatBooleanSelect(profile.firstGeneration), [
            ["", "Unknown"],
            ["true", "Yes"],
            ["false", "No"]
          ])}
          ${selectField("financialNeed", "Financial need", profile.financialNeed ?? "unknown", [
            ["unknown", "Unknown"],
            ["yes", "Yes"],
            ["no", "No"]
          ])}
          ${numberField("serviceHours", "Service hours", profile.serviceHours ?? "")}
          ${textField("streetAddress", "Street address", profile.streetAddress ?? "")}
          ${textField("city", "City", profile.city ?? "")}
          ${textField("postalCode", "ZIP code", profile.postalCode ?? "")}
        </div>
        ${textareaField("intendedMajors", "Intended majors", profile.intendedMajors.join(", "))}
        ${textareaField("collegesConsidering", "Colleges considering", (profile.collegesConsidering ?? []).join("\\n"))}
        ${textareaField("activities", "Activities", profile.activities.join("\\n"))}
        ${textareaField("awards", "Awards", profile.awards.join("\\n"))}
        ${textareaField("constraints", "Constraints", profile.constraints.join("\\n"))}
        ${textareaField("proudMoment", "Proud moment", profile.essayInterview.proudMoment)}
        ${textareaField("communityImpact", "Community impact", profile.essayInterview.communityImpact)}
        ${textareaField("challenge", "Challenge", profile.essayInterview.challenge)}
        ${textareaField("futureGoal", "Future goal", profile.essayInterview.futureGoal)}
        ${textareaField("voiceNotes", "Voice notes", profile.essayInterview.voiceNotes)}
        <p class="modal-status compact" hidden></p>
        <div class="modal-actions">
          <button class="ghost profile-cancel" type="button">Cancel</button>
          <button class="primary" type="submit">${student ? "Save Changes" : "Add Profile"}</button>
        </div>
      </form>
    </div>
  `;
  profileEditor.querySelectorAll(".profile-cancel").forEach((button) => button.addEventListener("click", closeProfileEditor));
  profileEditor.querySelector(".profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const profilePayload = profileFromForm(form);
    const validationMessage = validateProfilePayload(profilePayload);
    if (validationMessage) {
      setModalStatus(validationMessage, "error");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Saving...";
    setModalStatus(student ? "Saving profile..." : "Adding person...");
    setStatus(student ? "Saving profile..." : "Adding person...");

    try {
      const response = await fetch(student ? `/api/students/${student.id}` : "/api/students", {
        method: student ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profilePayload)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save profile.");
      saveProfilesSnapshot(mergeStudents(payload.dashboard?.students ?? [], payload.student ? [payload.student] : []));
      dashboard = mergeSavedStudentIntoDashboard(payload.dashboard, payload.student);
      saveProfilesFromDashboard();
      await syncSavedProfilesToServer();
      closeProfileEditor();
      setStatus(student ? "Profile updated." : "Person added.");
      render();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save profile.";
      setModalStatus(message, "error");
      setStatus(message);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });
}

function closeProfileEditor() {
  profileEditor.hidden = true;
  profileEditor.innerHTML = "";
}

function renderScholarshipItem(item) {
  const plan = dashboard.applicationPlans.find((candidate) => candidate.scholarshipId === item.id);
  return `
    <article class="item">
      <div class="item-head">
        <div class="item-title">
          <h3>${escapeHtml(item.title)}</h3>
          <p class="compact">${escapeHtml(item.provider)} · ${escapeHtml(item.award)} · due ${formatDate(item.deadline)}</p>
        </div>
        <div class="score">${item.fitScore}</div>
      </div>
      <p class="compact">${escapeHtml(item.sourceQuote)}</p>
      <div class="tags">
        <span class="pill ${item.effort}">${escapeHtml(item.effort)} effort</span>
        <span class="pill pending">${escapeHtml(item.status.replaceAll("_", " "))}</span>
        ${item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
      ${
        item.risks.length
          ? `<div class="tags">${item.risks.map((risk) => `<span class="pill medium">${escapeHtml(risk)}</span>`).join("")}</div>`
          : ""
      }
      ${
        plan
          ? `<div class="split">
              <button class="ghost browser" data-plan="${escapeHtml(plan.id)}">Prepare browser session</button>
              <button class="primary submission-start" type="button" data-plan="${escapeHtml(plan.id)}">Start Chrome Session</button>
            </div>
            ${renderSubmissionSessionControls(plan, item)}`
          : ""
      }
    </article>
  `;
}

function renderApprovalItem(item) {
  const reviewOpen = activeReviewApprovalId === item.id;
  const context = approvalContextFor(item);
  const autoStart = approvalStartsAutofill(item);
  const approveLabel = autoStart ? "Approve & Start Autofill" : "Approve";
  return `
    <article class="item">
      <div class="item-head">
        <div class="item-title">
          <h3>${escapeHtml(item.actionType.replaceAll("_", " "))}</h3>
          <p class="compact">${escapeHtml(item.summary)}</p>
        </div>
        <span class="pill ${item.status}">${escapeHtml(item.status)}</span>
      </div>
      <div class="tags">
        <span class="pill ${item.riskLevel}">${escapeHtml(item.riskLevel)} risk</span>
        <span class="tag">${escapeHtml(item.targetType)}</span>
      </div>
      ${context.plan ? renderApplyProfileBox(context.plan, context.scholarship) : ""}
      ${context.plan ? renderSubmissionSessionControls(context.plan, context.scholarship) : ""}
      ${
        item.status === "pending"
          ? `<div class="split">
              <button class="success approval" data-id="${item.id}" data-status="approved" ${autoStart ? 'data-auto-start="true"' : ""}>${approveLabel}</button>
              <button class="ghost approval-review" type="button" data-id="${item.id}">${reviewOpen ? "Hide Review" : "Review"}</button>
              <button class="danger approval" data-id="${item.id}" data-status="rejected">Reject</button>
            </div>`
          : `<p class="compact">${escapeHtml(item.decisionNote ?? "")}</p>`
      }
      ${reviewOpen ? renderApprovalReviewDetails(item) : ""}
    </article>
  `;
}

function approvalStartsAutofill(item) {
  return item?.status === "pending" && item?.actionType === "portal_submit" && item?.targetType === "application_plan";
}

function renderApplyProfileBox(plan, scholarship) {
  return `
    <label class="apply-profile-box">
      <span>Student profile applying${scholarship ? ` to ${escapeHtml(scholarship.title)}` : ""}</span>
      <select class="apply-profile-select" data-plan="${escapeHtml(plan.id)}">
        ${dashboard.students
          .map((student) => {
            const profile = student.profile;
            const label = `${profile.preferredName} · Class of ${profile.graduationYear} · ${profile.schoolState || "No state"}`;
            return `<option value="${escapeHtml(student.id)}" ${student.id === plan.studentId ? "selected" : ""}>${escapeHtml(label)}</option>`;
          })
          .join("")}
      </select>
    </label>
  `;
}

function renderSubmissionSessionControls(plan, scholarship) {
  const session = submissionSessionForPlan(plan.id);
  const student = dashboard.students.find((item) => item.id === plan.studentId);
  if (!session) {
    return `
      <div class="submission-session-card">
        <div class="submission-session-head">
          <div>
            <strong>Chrome submission session</strong>
            <p class="compact">Uses the dedicated Scholarship Applications Chrome profile and stops before final submit.</p>
          </div>
          <span class="pill pending">not started</span>
        </div>
      </div>
    `;
  }

  const blockers = session.blockers ?? [];
  const launchUrl = submissionLaunchUrl(session, plan, scholarship);
  return `
    <div class="submission-session-card" data-session="${escapeHtml(session.id)}">
      <div class="submission-session-head">
        <div>
          <strong>Chrome submission session</strong>
          <p class="compact">${escapeHtml(session.chromeProfileLabel)} profile · ${escapeHtml(student?.profile.preferredName ?? "Student")} · ${escapeHtml(scholarship?.title ?? "Application")}</p>
        </div>
        <span class="pill ${submissionStatusTone(session.status)}">${escapeHtml(session.status.replaceAll("_", " "))}</span>
      </div>
      <div class="submission-session-body">
        ${renderLaunchUrlControls(launchUrl)}
        ${renderExtensionFillControls(session, plan, scholarship)}
        <p class="compact">Safe steps staged: ${escapeHtml(session.steps?.length ?? 0)}. Submit buttons, signatures, payments, email sends, and recommendation requests stay blocked.</p>
        ${blockers.length ? `<div class="tags">${blockers.map((blocker) => `<span class="pill high">${escapeHtml(blocker)}</span>`).join("")}</div>` : ""}
        ${
          session.status === "waiting_for_manual_submit"
            ? renderSubmissionProofForm(session)
            : session.status === "submitted"
              ? renderSubmissionProofSummary(session)
              : ""
        }
      </div>
    </div>
  `;
}

function renderExtensionFillControls(session, plan, scholarship) {
  if (!session || session.status === "blocked" || session.status === "submitted") return "";
  return `
    <div class="extension-fill-box">
      <button class="primary extension-fill" type="button" data-session="${escapeHtml(session.id)}" data-plan="${escapeHtml(plan.id)}">Fill With Extension</button>
      <p class="compact">Sends this approved fill plan to the local Chrome extension for ${escapeHtml(scholarship?.title ?? "this application")}.</p>
    </div>
  `;
}

function renderLaunchUrlControls(launchUrl) {
  const valid = validApplicationUrl(launchUrl);
  const displayUrl = valid ?? launchUrl ?? "";
  return `
    <div class="launch-url-box">
      <span class="compact">Launch URL</span>
      <div class="split">
        <button class="ghost launch-url-open" type="button" data-launch-url="${escapeHtml(displayUrl)}">Open application URL</button>
        <button class="ghost launch-url-copy" type="button" data-launch-url="${escapeHtml(displayUrl)}">Copy URL</button>
      </div>
      <p class="compact">${valid ? escapeHtml(valid) : "This scholarship does not have a real application URL saved yet."}</p>
    </div>
  `;
}

function renderSubmissionProofForm(session) {
  return `
    <form class="submission-proof-form" data-session="${escapeHtml(session.id)}">
      <label>
        Confirmation text or number
        <textarea name="confirmationText" required placeholder="Paste the confirmation number or confirmation page text."></textarea>
      </label>
      <label>
        Screenshot proof
        <input name="screenshot" type="file" accept=".png,.jpg,.jpeg,.webp" />
      </label>
      <button class="success" type="submit">I Submitted This Application</button>
    </form>
  `;
}

function renderSubmissionProofSummary(session) {
  return `
    <div class="submission-proof-summary">
      <strong>Submission proof recorded</strong>
      <p>${escapeHtml(session.confirmationText ?? "Confirmation saved.")}</p>
      <p class="compact">${escapeHtml(formatDateTime(session.submittedAt))}${session.screenshotName ? ` · screenshot: ${escapeHtml(session.screenshotName)}` : ""}</p>
    </div>
  `;
}

function submissionSessionForPlan(planId) {
  return [...(dashboard.submissionSessions ?? [])]
    .filter((session) => session.applicationPlanId === planId)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
}

function submissionStatusTone(status) {
  if (status === "submitted") return "approved";
  if (status === "blocked" || status === "failed") return "high";
  if (status === "waiting_for_manual_submit") return "medium";
  return "pending";
}

function renderApprovalReviewDetails(item) {
  const context = approvalContextFor(item);
  const reviewStop = context.plan?.browserSteps.find((step) => step.action === "stop_for_review");
  return `
    <div class="review-panel">
      <div class="review-head">
        <div>
          <h4>Review Details</h4>
          <p class="compact">Check the source context before approving. Approval still does not click submit, sign, pay, or send anything by itself.</p>
        </div>
        <span class="pill ${item.riskLevel}">${escapeHtml(item.riskLevel)} risk</span>
      </div>
      <div class="review-grid">
        ${reviewFact("Action", item.actionType.replaceAll("_", " "))}
        ${reviewFact("Target", item.targetType.replaceAll("_", " "))}
        ${context.student ? reviewFact("Student", `${context.student.profile.preferredName} · Class of ${context.student.profile.graduationYear}`) : ""}
        ${context.scholarship ? reviewFact("Scholarship", `${context.scholarship.title} · due ${formatDate(context.scholarship.deadline)}`) : ""}
      </div>
      ${
        context.scholarship
          ? `<div class="review-section">
              <strong>Scholarship source</strong>
              <p>${escapeHtml(context.scholarship.provider)} · ${escapeHtml(context.scholarship.award)}</p>
              <p class="compact">${escapeHtml(context.scholarship.sourceQuote)}</p>
            </div>`
          : ""
      }
      ${
        context.plan
          ? `<div class="review-section">
              <strong>Application prep</strong>
              ${reviewList("Missing fields", context.plan.missingFields)}
              ${reviewList("Document requests", context.plan.documentRequests)}
              ${reviewFieldMap(context.plan.fieldMap)}
              ${reviewStop ? `<p class="compact"><strong>Stop point:</strong> ${escapeHtml(reviewStop.note)}</p>` : ""}
            </div>`
          : ""
      }
      ${
        context.essay
          ? `<div class="review-section">
              <strong>Essay draft</strong>
              <p class="compact">${escapeHtml(context.essay.prompt)}</p>
              ${reviewList("Unsupported claims", context.essay.unsupportedClaims)}
            </div>`
          : ""
      }
      ${
        context.document
          ? `<div class="review-section">
              <strong>Document</strong>
              <p>${escapeHtml(context.document.type)} · ${escapeHtml(context.document.name)}</p>
              <p class="compact">Status: ${escapeHtml(context.document.status.replaceAll("_", " "))}</p>
            </div>`
          : ""
      }
    </div>
  `;
}

function approvalContextFor(item) {
  const plan = item.targetType === "application_plan" ? dashboard.applicationPlans.find((candidate) => candidate.id === item.targetId) : null;
  const scholarship =
    item.targetType === "scholarship"
      ? dashboard.scholarships.find((candidate) => candidate.id === item.targetId)
      : plan
        ? dashboard.scholarships.find((candidate) => candidate.id === plan.scholarshipId)
        : null;
  const student = plan ? dashboard.students.find((candidate) => candidate.id === plan.studentId) : null;
  const essay =
    item.targetType === "essay"
      ? dashboard.essayDrafts.find((candidate) => candidate.id === item.targetId)
      : plan
        ? dashboard.essayDrafts.find((candidate) => candidate.studentId === plan.studentId && candidate.scholarshipId === plan.scholarshipId)
        : null;
  const document = item.targetType === "document" ? dashboard.documents.find((candidate) => candidate.id === item.targetId) : null;
  return { plan, scholarship, student, essay, document };
}

function reviewFact(label, value) {
  return `
    <div class="review-fact">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function reviewList(label, values) {
  if (!values?.length) return `<p class="compact"><strong>${escapeHtml(label)}:</strong> None flagged.</p>`;
  return `
    <div class="review-list">
      <strong>${escapeHtml(label)}</strong>
      <div class="tags">
        ${values.map((value) => `<span class="pill medium">${escapeHtml(value)}</span>`).join("")}
      </div>
    </div>
  `;
}

function reviewFieldMap(fieldMap) {
  const entries = Object.entries(fieldMap ?? {}).filter(([, value]) => String(value ?? "").trim());
  if (!entries.length) return `<p class="compact"><strong>Prefilled fields:</strong> None ready yet.</p>`;
  return `
    <div class="review-field-map">
      <strong>Prefilled fields</strong>
      ${entries
        .map(
          ([field, value]) => `
            <div>
              <span>${escapeHtml(field.replaceAll("_", " "))}</span>
              <p>${escapeHtml(value)}</p>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function wireApprovalButtons() {
  document.querySelectorAll(".approval").forEach((button) => {
    button.addEventListener("click", async () => {
      const approving = button.dataset.status === "approved";
      const autoStart = approving && button.dataset.autoStart === "true";
      const approval = dashboard.approvals.find((item) => item.id === button.dataset.id);
      const context = approval ? approvalContextFor(approval) : {};
      const launchUrl = context.plan ? planLaunchUrl(context.plan, context.scholarship) : "";
      const pendingWindow = autoStart ? openPendingApplicationWindow(launchUrl) : null;
      await withStatus(autoStart ? "Approving and starting Chrome autofill..." : `${approving ? "Approving" : "Rejecting"} action...`, async () => {
        const response = await fetch(
          autoStart ? `/api/approvals/${button.dataset.id}/approve-and-start` : `/api/approvals/${button.dataset.id}/decision`,
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: button.dataset.status,
            note: autoStart ? "Approved and started autofill from the Application Review Queue." : "Decision recorded in local app.",
            runLocalAutofill: autoStart ? false : undefined
          })
        }
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Approval action failed.");
        if (payload.dashboard) dashboard = await hydrateDashboard(payload.dashboard);
        if (activeReviewApprovalId === button.dataset.id) activeReviewApprovalId = null;
        if (autoStart) {
          const extensionResult = payload.started ? await sendToChromeExtension(extensionHandoffPayload(payload)) : null;
          if (extensionResult?.ok) {
            setStatus(extensionResult.response?.result?.message || "Fill plan sent to the Chrome extension.");
          } else if (payload.started) {
            openApplicationUrl(payload.launchUrl, pendingWindow);
          }
          else closePendingApplicationWindow(pendingWindow);
          if (payload.started && extensionResult && !extensionResult.ok) {
            setStatus(`${autofillStatusMessage(payload)} ${extensionResult.error || "Chrome extension was not detected; use the opened tab or Start Chrome Session."}`);
          } else if (!extensionResult?.ok) {
            setStatus(autofillStatusMessage(payload));
          }
        } else {
          setStatus(`Approval ${button.dataset.status}.`);
        }
        render();
      });
    });
  });
  document.querySelectorAll(".approval-review").forEach((button) => {
    button.addEventListener("click", () => {
      activeReviewApprovalId = activeReviewApprovalId === button.dataset.id ? null : button.dataset.id;
      setStatus(activeReviewApprovalId ? "Review details opened." : "Review details hidden.");
      render();
    });
  });
}

function autofillStatusMessage(payload) {
  const autofill = payload?.autofill ?? {};
  const blockers = autofill.blockers ?? payload?.submissionSession?.blockers ?? [];
  if (!payload?.started || autofill.status === "blocked") {
    return blockers.length
      ? `Approved, but autofill is blocked: ${blockers.join(" ")}`
      : "Approved, but autofill is blocked until the remaining approvals are complete.";
  }
  if (autofill.status === "waiting_for_login") return autofill.message || "Chrome is open. Log in manually, then start again.";
  if (autofill.status === "failed") return autofill.message || "Chrome autofill failed. Open the application URL manually.";
  if (autofill.status === "unavailable") return autofill.message || "Local Chrome autofill is unavailable. Use the opened scholarship page manually.";
  if (autofill.status === "local_companion_ready") {
    return autofill.message || "Approved. Local Chrome companion is ready for autofill.";
  }
  return autofill.message || "Autofill started. Review the scholarship page and submit manually when ready.";
}

function wireApplyProfileSelectors() {
  document.querySelectorAll(".apply-profile-select").forEach((select) => {
    select.addEventListener("change", async () => {
      const student = dashboard.students.find((item) => item.id === select.value);
      const plan = dashboard.applicationPlans.find((item) => item.id === select.dataset.plan);
      const scholarship = plan ? dashboard.scholarships.find((item) => item.id === plan.scholarshipId) : null;
      await withStatus(`Selecting ${student?.profile.preferredName ?? "student"} for ${scholarship?.title ?? "this scholarship"}...`, async () => {
        await syncSavedProfilesToServer();
        await syncSavedDocumentsToServer();
        const response = await fetch(`/api/application-plans/${select.dataset.plan}/student`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId: select.value })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not select student profile.");
        dashboard = await hydrateDashboard(payload.dashboard);
        setStatus(`${student?.profile.preferredName ?? "Student"} selected for ${scholarship?.title ?? "scholarship"}.`);
        render();
      });
    });
  });
}

function wireBrowserButtons() {
  document.querySelectorAll(".browser").forEach((button) => {
    button.addEventListener("click", async () => {
      await withStatus("Preparing safe browser session...", async () => {
        const response = await fetch("/api/browser-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationPlanId: button.dataset.plan })
        });
        const session = await response.json();
        if (!response.ok) throw new Error(session.error || "Could not prepare the browser plan.");
        setStatus(`Browser plan prepared with ${session.steps.length} steps. Stop point: ${session.reviewStop.note}`);
      });
    });
  });
}

function wireSubmissionButtons() {
  wireLaunchUrlButtons();
  wireExtensionFillButtons();
  document.querySelectorAll(".submission-start").forEach((button) => {
    button.addEventListener("click", async () => {
      const plan = dashboard.applicationPlans.find((item) => item.id === button.dataset.plan);
      const scholarship = dashboard.scholarships.find((item) => item.id === plan?.scholarshipId);
      const pendingWindow = openPendingApplicationWindow(planLaunchUrl(plan, scholarship));
      await withStatus("Starting Chrome submission session...", async () => {
        const session = await ensureSubmissionSession(button.dataset.plan);
        const response = await fetch(`/api/submission-sessions/${encodeURIComponent(session.id)}/start`, { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (payload.dashboard) dashboard = await hydrateDashboard(payload.dashboard);
        if (!response.ok) {
          closePendingApplicationWindow(pendingWindow);
          render();
          throw new Error(payload.error || "Could not start the Chrome session.");
        }
        dashboard = await hydrateDashboard(payload.dashboard);
        openApplicationUrl(submissionLaunchUrl(payload.submissionSession, plan, scholarship), pendingWindow);
        setStatus(
          payload.autofill
            ? autofillStatusMessage({ ...payload, started: true })
            : `Application page opened. Chrome session ready in ${payload.chromeProfileLabel}. Stop before submit; record proof after you manually submit.`
        );
        render();
      });
    });
  });

  document.querySelectorAll(".submission-proof-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const confirmationText = String(formData.get("confirmationText") ?? "").trim();
      if (!confirmationText) {
        setStatus("Paste the confirmation number or confirmation text first.");
        return;
      }
      const screenshot = form.querySelector('input[name="screenshot"]')?.files?.[0];
      const proofId = `submission-proof-${form.dataset.session}`;
      const proof = {};
      await withStatus("Recording submission proof...", async () => {
        if (screenshot) {
          await saveDocumentFile(proofId, screenshot);
          proof.screenshotName = screenshot.name;
          proof.screenshotPath = `browser-local://${proofId}/${screenshot.name}`;
        }
        const response = await fetch(`/api/submission-sessions/${encodeURIComponent(form.dataset.session)}/confirm-submitted`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmationText, ...proof })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not record submission proof.");
        dashboard = await hydrateDashboard(payload.dashboard);
        setStatus("Submission proof recorded.");
        render();
      });
    });
  });
}

function wireExtensionFillButtons() {
  document.querySelectorAll(".extension-fill").forEach((button) => {
    button.addEventListener("click", async () => {
      const session = dashboard.submissionSessions.find((item) => item.id === button.dataset.session);
      const plan = dashboard.applicationPlans.find((item) => item.id === button.dataset.plan);
      const scholarship = dashboard.scholarships.find((item) => item.id === plan?.scholarshipId);
      const launchUrl = submissionLaunchUrl(session, plan, scholarship);
      const pendingWindow = openPendingApplicationWindow(launchUrl);
      await withStatus("Sending fill plan to Chrome extension...", async () => {
        const response = await fetch(`/api/submission-sessions/${encodeURIComponent(button.dataset.session)}/companion-token`, { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          closePendingApplicationWindow(pendingWindow);
          throw new Error(payload.error || "Could not create an extension handoff token.");
        }
        const extensionResult = await sendToChromeExtension(
          extensionHandoffPayload({
            ...payload,
            submissionSession: session,
            launchUrl
          })
        );
        if (extensionResult.ok) {
          setStatus(extensionResult.response?.result?.message || "Fill plan sent to the Chrome extension.");
          return;
        }
        openApplicationUrl(launchUrl, pendingWindow);
        setStatus(`${extensionResult.error || "Chrome extension was not detected."} The application URL opened so you can continue manually.`);
      });
    });
  });
}

function wireLaunchUrlButtons() {
  document.querySelectorAll(".launch-url-open").forEach((button) => {
    button.addEventListener("click", () => {
      openApplicationUrl(button.dataset.launchUrl);
    });
  });
  document.querySelectorAll(".launch-url-copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const url = validApplicationUrl(button.dataset.launchUrl);
      if (!url) {
        setStatus("This scholarship does not have a real application URL saved yet.");
        return;
      }
      await copyShareValue(url, "application URL");
    });
  });
}

function extensionHandoffPayload(payload) {
  const session = payload?.submissionSession;
  const plan = session ? dashboard.applicationPlans.find((item) => item.id === session.applicationPlanId) : null;
  const scholarship = plan ? dashboard.scholarships.find((item) => item.id === plan.scholarshipId) : null;
  const student = plan ? dashboard.students.find((item) => item.id === plan.studentId) : null;
  return {
    apiBaseUrl: window.location.origin,
    token: payload?.token ?? "",
    launchUrl: payload?.launchUrl ?? session?.launchUrl ?? planLaunchUrl(plan, scholarship),
    submissionSessionId: session?.id ?? payload?.companionToken?.submissionSessionId ?? "",
    scholarshipTitle: scholarship?.title ?? "",
    studentName: student?.profile?.preferredName ?? ""
  };
}

function sendToChromeExtension(payload) {
  if (!payload?.token) {
    return Promise.resolve({ ok: false, error: "No extension handoff token was created." });
  }
  return new Promise((resolve) => {
    const requestId = `scholarship-extension-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", listener);
      resolve(result);
    };
    const listener = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "SCHOLARSHIP_AGENT_EXTENSION_ACK") return;
      if (event.data.requestId !== requestId) return;
      finish({
        ok: Boolean(event.data.ok),
        response: event.data.response,
        error: event.data.error || event.data.response?.error || ""
      });
    };
    window.addEventListener("message", listener);
    window.postMessage(
      {
        type: "SCHOLARSHIP_AGENT_EXTENSION_HANDOFF",
        requestId,
        payload
      },
      window.location.origin
    );
    window.setTimeout(() => finish({ ok: false, error: "Chrome extension was not detected." }), 10000);
  });
}

function openPendingApplicationWindow(rawUrl) {
  const url = validApplicationUrl(rawUrl);
  if (!url) return null;
  const opened = window.open(url, "_blank");
  if (!opened) {
    setStatus("Your browser blocked the new tab. Copy and paste the application URL into Chrome.");
    return null;
  }
  return opened;
}

function closePendingApplicationWindow(pendingWindow) {
  try {
    pendingWindow?.close();
  } catch {
    // The user may already have closed the pending tab.
  }
}

function openApplicationUrl(rawUrl, pendingWindow = null) {
  const url = validApplicationUrl(rawUrl);
  if (!url) {
    closePendingApplicationWindow(pendingWindow);
    setStatus("This scholarship does not have a real application URL saved yet.");
    return false;
  }
  if (pendingWindow) {
    pendingWindow.location.href = url;
    setStatus("Opening the scholarship application page in a new tab.");
    return true;
  }
  const opened = window.open(url, "_blank", "noopener");
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      // Some browsers prevent assigning opener; the tab has still been opened.
    }
  }
  if (!opened) {
    setStatus("Your browser blocked the new tab. Copy and paste the application URL into Chrome.");
    return false;
  }
  setStatus("Opening the scholarship application page in a new tab.");
  return true;
}

function submissionLaunchUrl(session, plan, scholarship) {
  return firstValidApplicationUrl(
    session?.launchUrl,
    planLaunchUrl(plan, scholarship),
    scholarshipApplicationFallback(scholarship)
  );
}

function planLaunchUrl(plan, scholarship) {
  const navigateStep = plan?.browserSteps?.find((step) => step.action === "navigate");
  return firstValidApplicationUrl(navigateStep?.url, scholarship?.url, scholarshipApplicationFallback(scholarship));
}

function scholarshipApplicationFallback(scholarship) {
  return SCHOLARSHIP_APPLICATION_URL_FALLBACKS[scholarship?.title] ?? "";
}

function firstValidApplicationUrl(...urls) {
  for (const url of urls) {
    const valid = validApplicationUrl(url);
    if (valid) return valid;
  }
  return String(urls.find(Boolean) ?? "");
}

function validApplicationUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (isPlaceholderApplicationHost(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function isPlaceholderApplicationHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host === "example.org" || host === "example.com" || host === "example.net" || host === "example.test" || host.endsWith(".example.org") || host.endsWith(".example.test");
}

async function ensureSubmissionSession(planId) {
  const existing = submissionSessionForPlan(planId);
  if (existing) return existing;
  const response = await fetch("/api/submission-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applicationPlanId: planId })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not create a Chrome submission session.");
  dashboard = await hydrateDashboard(payload.dashboard);
  return payload.submissionSession;
}

async function withStatus(message, task) {
  setStatus(message);
  try {
    await task();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Something went wrong.");
  }
}

function connectLiveEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("open", () => {
    setStatus("Live portal updates connected.");
  });
  eventSource.addEventListener("connected", (event) => {
    const payload = parseEventPayload(event);
    setStatus(payload.message);
  });
  eventSource.addEventListener("agent_progress", (event) => {
    const payload = parseEventPayload(event);
    setStatus(payload.message);
  });
  eventSource.addEventListener("dashboard_changed", async (event) => {
    const payload = parseEventPayload(event);
    dashboard = await hydrateDashboard(payload.data);
    setStatus(payload.message);
    render();
  });
  eventSource.onerror = () => {
    if (eventSource?.readyState === EventSource.CLOSED) {
      setStatus("Live connection paused. Refresh will still work.");
      return;
    }
    setStatus("Live connection is reconnecting. Refresh still works.");
  };
}

function parseEventPayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return { message: "A live update could not be read. Refresh still works." };
  }
}

function setStatus(message) {
  statusBox.hidden = false;
  statusBox.textContent = message;
}

function metric(label, value) {
  return `<div class="metric"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function settingsData() {
  return dashboard?.settings ?? defaultSettings();
}

function portalShareBaseUrl() {
  return window.location.origin.replace(/\/$/, "");
}

async function copyShareValue(value, label = "URL") {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setStatus(`Copied ${label}.`);
  } catch {
    setStatus(`Copy this ${label}: ${value}`);
  }
}

function defaultSettings() {
  return {
    users: [
      {
        id: "owner",
        name: "Parent",
        email: currentUser?.email ?? "parent@example.com",
        role: "Admin",
        status: "active",
        profileAccess: "all",
        profileIds: []
      }
    ],
    customBoxes: [],
    customFields: [],
    customTabs: [],
    roleRights: defaultRoleRights(),
    updatedAt: new Date().toISOString()
  };
}

function defaultRoleRights() {
  return {
    Admin: {
      manageSettings: true,
      manageUsers: true,
      manageProfiles: true,
      manageScholarships: true,
      prepareApplications: true,
      approveActions: true,
      viewAudit: true
    },
    Employee: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: true,
      manageScholarships: true,
      prepareApplications: true,
      approveActions: false,
      viewAudit: false
    },
    Guest: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: false,
      manageScholarships: false,
      prepareApplications: false,
      approveActions: false,
      viewAudit: false
    },
    Viewer: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: false,
      manageScholarships: false,
      prepareApplications: false,
      approveActions: false,
      viewAudit: true
    }
  };
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function roleDescription(role) {
  if (role === "Admin") return "Full settings, user, approval, and workspace control";
  if (role === "Employee") return "Can help edit profiles and prepare applications";
  if (role === "Guest") return "Limited collaborator access with no admin rights";
  return "Read-only access with no admin rights";
}

function roleLabel(role) {
  return role === "Employee" ? "Contributor" : role;
}

function renderProfileCheckboxes(selectedIds, inputName, inputClass = "") {
  if (!dashboard.students.length) return `<p class="compact">No Profiles available</p>`;
  const selectedSet = new Set(selectedIds ?? []);
  return dashboard.students
    .map((student) => {
      const name = student.profile?.preferredName || student.name || "Unnamed Profile";
      return `
        <label class="settings-profile-option">
          <input
            class="${escapeHtml(inputClass)}"
            type="checkbox"
            name="${escapeHtml(inputName)}"
            value="${escapeHtml(student.id)}"
            ${selectedSet.has(student.id) ? "checked" : ""}
          />
          <span>${escapeHtml(name)}</span>
        </label>
      `;
    })
    .join("");
}

function selectedProfileIds(container) {
  return Array.from(container?.querySelectorAll('input[type="checkbox"]:checked') ?? [])
    .map((checkbox) => checkbox.value)
    .filter(Boolean);
}

function assignedProfileNames(profileIds) {
  const ids = Array.isArray(profileIds) ? profileIds : [];
  return ids
    .map((id) => dashboard.students.find((student) => student.id === id)?.profile?.preferredName)
    .filter(Boolean);
}

function profileAccessSummary(user) {
  if (user.role === "Admin" || user.profileAccess === "all") return "All Profiles";
  const names = assignedProfileNames(user.profileIds);
  return names.length ? names.join(", ") : "No Profiles assigned";
}

function labelFor(options, value) {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? titleCase(String(value).replaceAll("_", " "));
}

function emptyProfile() {
  return {
    preferredName: "",
    legalName: "",
    firstName: "",
    lastName: "",
    email: "",
    gender: "",
    dateOfBirth: "",
    graduationYear: new Date().getFullYear() + 1,
    graduationMonth: "June",
    gradeLevel: "junior",
    schoolState: "",
    highSchoolName: "",
    gpa: undefined,
    citizenship: "unknown",
    firstGeneration: undefined,
    financialNeed: "unknown",
    intendedMajors: [],
    collegesConsidering: [],
    activities: [],
    serviceHours: undefined,
    awards: [],
    streetAddress: "",
    city: "",
    postalCode: "",
    constraints: [],
    essayInterview: {
      proudMoment: "",
      communityImpact: "",
      challenge: "",
      futureGoal: "",
      voiceNotes: ""
    }
  };
}

function normalizeProfileForUi(profile = {}) {
  const base = emptyProfile();
  const input = profile && typeof profile === "object" ? profile : {};
  const normalized = {
    ...base,
    ...input,
    intendedMajors: normalizeTextList(input.intendedMajors),
    collegesConsidering: normalizeTextList(input.collegesConsidering),
    activities: normalizeTextList(input.activities),
    awards: normalizeTextList(input.awards),
    constraints: normalizeTextList(input.constraints),
    essayInterview: {
      ...base.essayInterview,
      ...(input.essayInterview && typeof input.essayInterview === "object" ? input.essayInterview : {})
    }
  };
  normalized.citizenship = normalized.citizenship || base.citizenship;
  normalized.financialNeed = normalized.financialNeed || base.financialNeed;
  normalized.gradeLevel = normalized.gradeLevel || base.gradeLevel;
  normalized.graduationMonth = normalized.graduationMonth || base.graduationMonth;
  normalized.graduationYear = Number(normalized.graduationYear) || base.graduationYear;
  return normalized;
}

function normalizeTextList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return splitList(value ?? "");
}

function profileFromForm(form) {
  const formData = new FormData(form);
  return {
    preferredName: String(formData.get("preferredName") ?? "").trim(),
    legalName: String(formData.get("legalName") ?? "").trim(),
    firstName: String(formData.get("firstName") ?? "").trim(),
    lastName: String(formData.get("lastName") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    gender: String(formData.get("gender") ?? "").trim(),
    dateOfBirth: String(formData.get("dateOfBirth") ?? "").trim(),
    graduationYear: Number(formData.get("graduationYear")),
    graduationMonth: String(formData.get("graduationMonth") ?? "").trim(),
    gradeLevel: String(formData.get("gradeLevel") ?? "junior"),
    schoolState: String(formData.get("schoolState") ?? "").trim().toUpperCase(),
    highSchoolName: String(formData.get("highSchoolName") ?? "").trim(),
    gpa: optionalNumber(formData.get("gpa")),
    citizenship: String(formData.get("citizenship") ?? "unknown"),
    firstGeneration: optionalBoolean(formData.get("firstGeneration")),
    financialNeed: String(formData.get("financialNeed") ?? "unknown"),
    intendedMajors: splitList(formData.get("intendedMajors")),
    collegesConsidering: splitList(formData.get("collegesConsidering")),
    activities: splitList(formData.get("activities")),
    serviceHours: optionalNumber(formData.get("serviceHours")),
    awards: splitList(formData.get("awards")),
    streetAddress: String(formData.get("streetAddress") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    postalCode: String(formData.get("postalCode") ?? "").trim(),
    constraints: splitList(formData.get("constraints")),
    essayInterview: {
      proudMoment: String(formData.get("proudMoment") ?? "").trim(),
      communityImpact: String(formData.get("communityImpact") ?? "").trim(),
      challenge: String(formData.get("challenge") ?? "").trim(),
      futureGoal: String(formData.get("futureGoal") ?? "").trim(),
      voiceNotes: String(formData.get("voiceNotes") ?? "").trim()
    }
  };
}

function validateProfilePayload(profile) {
  if (!profile.preferredName) return "Preferred name is required.";
  if (!profile.legalName) return "Legal name is required.";
  if (!profile.firstName) return "First name for applications is required.";
  if (!profile.email) return "Student email is required.";
  if (!isValidEmail(profile.email)) return "Enter a valid student email address.";
  if (!profile.graduationYear || !Number.isFinite(profile.graduationYear)) return "Graduation year is required.";
  if (!profile.schoolState) return "School state is required.";
  return "";
}

function firstNameFromLegalName(name) {
  return String(name || "").trim().split(/\s+/)[0] ?? "";
}

function lastNameFromLegalName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function setModalStatus(message, tone = "info") {
  const modalStatus = profileEditor.querySelector(".modal-status");
  if (!modalStatus) return;
  modalStatus.hidden = false;
  modalStatus.textContent = message;
  modalStatus.dataset.tone = tone;
}

function textField(name, label, value = "", required = false) {
  return `
    <label>
      ${escapeHtml(label)}
      <input name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""} />
    </label>
  `;
}

function emailField(name, label, value = "", required = false) {
  return `
    <label>
      ${escapeHtml(label)}
      <input name="${escapeHtml(name)}" type="email" autocomplete="email" value="${escapeHtml(value ?? "")}" ${required ? "required" : ""} />
    </label>
  `;
}

function dateField(name, label, value = "", required = false) {
  return `
    <label>
      ${escapeHtml(label)}
      <input name="${escapeHtml(name)}" type="date" value="${escapeHtml(value ?? "")}" ${required ? "required" : ""} />
    </label>
  `;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? ""));
}

function numberField(name, label, value = "", required = false, step = "1") {
  return `
    <label>
      ${escapeHtml(label)}
      <input name="${escapeHtml(name)}" type="number" step="${escapeHtml(step)}" value="${escapeHtml(value)}" ${required ? "required" : ""} />
    </label>
  `;
}

function selectField(name, label, value, options) {
  return `
    <label>
      ${escapeHtml(label)}
      <select name="${escapeHtml(name)}">
        ${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`).join("")}
      </select>
    </label>
  `;
}

function textareaField(name, label, value = "") {
  return `
    <label class="wide">
      ${escapeHtml(label)}
      <textarea name="${escapeHtml(name)}" rows="3">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function profileFact(label, value) {
  return `
    <div class="profile-fact">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function profileTagGroup(label, values, tone = "") {
  if (!values?.length) return "";
  return `
    <div class="profile-group">
      <strong>${escapeHtml(label)}</strong>
      <div class="tags">
        ${values.map((value) => `<span class="pill ${tone}">${escapeHtml(value)}</span>`).join("")}
      </div>
    </div>
  `;
}

function profileNote(label, value) {
  if (!value) return "";
  return `
    <div class="profile-note">
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(value)}</p>
    </div>
  `;
}

function empty(message) {
  return `<p class="compact">${escapeHtml(message)}</p>`;
}

function splitList(value) {
  return String(value ?? "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function optionalBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function formatBooleanSelect(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function formatYesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isAcceptedDocumentFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  return DOCUMENT_FILE_ACCEPT.split(",").some((extension) => name.endsWith(extension));
}

function titleCase(value) {
  return String(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
