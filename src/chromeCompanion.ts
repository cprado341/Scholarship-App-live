import { existsSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { ApplicationPlan, BrowserStep, DocumentRecord, SubmissionSession, SubmissionSessionStatus } from "./types.ts";

type CdpResponse = { id: number; result?: unknown; error?: { message?: string } };

export interface ChromeAutofillResult {
  status: "started" | "waiting_for_login" | "waiting_for_manual_submit" | "unavailable" | "failed" | "local_companion_ready";
  sessionStatus: SubmissionSessionStatus;
  launchUrl: string;
  filledFields: string[];
  skippedFields: string[];
  blockers: string[];
  message: string;
}

interface ChromeAutofillInput {
  session: SubmissionSession;
  plan: ApplicationPlan;
  documents: DocumentRecord[];
  baseDir: string;
}

interface ChromeTarget {
  webSocketDebuggerUrl?: string;
}

interface PageState {
  loginRequired: boolean;
  reviewReady: boolean;
  blockerText: string[];
}

let chromeProcess: ChildProcessWithoutNullStreams | undefined;

export async function startChromeAutofill(input: ChromeAutofillInput): Promise<ChromeAutofillResult> {
  const launchUrl = validLaunchUrl(input.session.launchUrl);
  if (!launchUrl) {
    return unavailable(input.session.launchUrl, "This scholarship does not have a real application URL saved yet.");
  }

  if (process.env.VERCEL || process.env.DISABLE_LOCAL_CHROME_AUTOFILL === "1") {
    return unavailable(launchUrl, "Local Chrome autofill is only available from the local/IIS app runtime.");
  }

  const executable = findChromeExecutable();
  if (!executable) {
    return unavailable(launchUrl, "Google Chrome was not found on this computer. Open the URL manually or install Chrome.");
  }

  try {
    const port = Number(process.env.SCHOLARSHIP_CHROME_DEBUG_PORT ?? 9337);
    const userDataDir = process.env.SCHOLARSHIP_CHROME_PROFILE_DIR ?? path.join(input.baseDir, "data", "chrome-scholarship-profile");
    mkdirSync(userDataDir, { recursive: true });
    await ensureChromeRunning(executable, userDataDir, port, launchUrl);
    const target = await openChromeTarget(port, launchUrl);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl ?? "");
    try {
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await delay(900);
      const result = await fillPlanSteps(cdp, input);
      const pageState = await inspectPageState(cdp);
      if (pageState.loginRequired) {
        return {
          status: "waiting_for_login",
          sessionStatus: "waiting_for_login",
          launchUrl,
          filledFields: result.filledFields,
          skippedFields: result.skippedFields,
          blockers: [...result.blockers, ...pageState.blockerText],
          message: "Chrome is open. Log in manually, then use Start Chrome Session again to continue autofill."
        };
      }
      if (pageState.blockerText.length) {
        return {
          status: "waiting_for_manual_submit",
          sessionStatus: "waiting_for_manual_submit",
          launchUrl,
          filledFields: result.filledFields,
          skippedFields: result.skippedFields,
          blockers: [...result.blockers, ...pageState.blockerText],
          message: "Autofill stopped at a sensitive review step. Check the page before manual submit."
        };
      }
      return {
        status: pageState.reviewReady ? "waiting_for_manual_submit" : "started",
        sessionStatus: "waiting_for_manual_submit",
        launchUrl,
        filledFields: result.filledFields,
        skippedFields: result.skippedFields,
        blockers: result.blockers,
        message: pageState.reviewReady
          ? "Autofill reached the final review area. Submit manually on the scholarship page."
          : "Autofill finished the known fields. Review the scholarship page and submit manually when ready."
      };
    } finally {
      cdp.close();
    }
  } catch (error) {
    return {
      status: "failed",
      sessionStatus: "failed",
      launchUrl,
      filledFields: [],
      skippedFields: [],
      blockers: [error instanceof Error ? error.message : "Chrome autofill failed."],
      message: "Chrome autofill could not finish. Open the application URL manually and review the fill plan."
    };
  }
}

export function planAutofillSummary(steps: BrowserStep[]): { fillSteps: number; uploadSteps: number; stopSteps: number } {
  return {
    fillSteps: steps.filter((step) => step.action === "fill").length,
    uploadSteps: steps.filter((step) => step.action === "upload").length,
    stopSteps: steps.filter((step) => step.action === "stop_for_review").length
  };
}

async function fillPlanSteps(cdp: CdpClient, input: ChromeAutofillInput) {
  const filledFields: string[] = [];
  const skippedFields: string[] = [];
  const blockers: string[] = [];
  for (const step of input.session.steps) {
    if (step.action === "navigate") continue;
    if (step.action === "stop_for_review") {
      blockers.push(step.note);
      continue;
    }
    if (step.action === "fill") {
      const result = await fillField(cdp, step);
      if (result.ok) filledFields.push(result.label);
      else skippedFields.push(result.label);
      continue;
    }
    if (step.action === "upload") {
      const document = input.documents.find((item) => item.id === step.documentId);
      const filePath = resolveDocumentPath(document, input.baseDir);
      if (!filePath) {
        skippedFields.push(`${step.selector}: document file needs manual upload`);
        continue;
      }
      const uploaded = await uploadFile(cdp, step.selector, filePath);
      if (uploaded) filledFields.push(`${step.selector}: ${document?.name ?? "document"}`);
      else skippedFields.push(`${step.selector}: file input not found`);
    }
  }
  return { filledFields, skippedFields, blockers };
}

async function fillField(cdp: CdpClient, step: Extract<BrowserStep, { action: "fill" }>): Promise<{ ok: boolean; label: string }> {
  const value = await cdp.evaluate(
    `(function(selector, aliases, label, value) {
      const selectors = [selector].concat(Array.isArray(aliases) ? aliases : []).filter(Boolean);
      let element = null;
      for (const candidate of selectors) {
        try {
          element = document.querySelector(candidate);
        } catch {
          element = null;
        }
        if (element) break;
      }
      if (!element) return { ok: false, label: label + ": not on this page yet" };
      const tag = String(element.tagName || "").toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (["submit", "button", "image", "reset", "password", "file", "hidden"].includes(type)) {
        return { ok: false, label: label + ": unsafe or unsupported field type" };
      }
      if ((type === "checkbox" || type === "radio") && isAttestationControl(element)) {
        return { ok: false, label: label + ": attestation control left for manual review" };
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.focus();
      if (tag === "select") {
        const normalized = String(value).trim().toLowerCase();
        const option = Array.from(element.options).find((item) => {
          return String(item.value).trim().toLowerCase() === normalized || String(item.textContent).trim().toLowerCase() === normalized;
        });
        if (option) element.value = option.value;
        else element.value = value;
      } else if (type === "checkbox") {
        element.checked = /^(true|yes|1|on)$/i.test(String(value));
      } else if (type === "radio") {
        const radio = document.querySelector('input[type="radio"][name="' + CSS.escape(element.name) + '"][value="' + CSS.escape(String(value)) + '"]');
        if (radio) radio.checked = true;
        else element.checked = /^(true|yes|1|on)$/i.test(String(value));
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, label };

      function normalize(value) {
        return String(value || "")
          .toLowerCase()
          .replace(/[_-]+/g, " ")
          .replace(/[^a-z0-9 ]+/g, " ")
          .replace(/\\s+/g, " ")
          .trim();
      }

      function escapeCss(value) {
        return window.CSS?.escape ? CSS.escape(value) : String(value || "").replace(/["\\\\]/g, "\\\\$&");
      }

      function labelText(field) {
        if (field.id) {
          const label = document.querySelector('label[for="' + escapeCss(field.id) + '"]');
          if (label) return label.textContent || "";
        }
        const wrappingLabel = field.closest("label");
        return wrappingLabel ? wrappingLabel.textContent || "" : "";
      }

      function isAttestationControl(field) {
        const signal = normalize([
          field.getAttribute("name"),
          field.id,
          field.getAttribute("aria-label"),
          field.getAttribute("placeholder"),
          labelText(field)
        ].join(" "));
        return /\\b(attest|attestation|agree|certify|certification|accurate|accuracy|terms)\\b/.test(signal);
      }
    })(${JSON.stringify(step.selector)}, ${JSON.stringify(step.aliases ?? [])}, ${JSON.stringify(step.label ?? step.selector)}, ${JSON.stringify(step.value)})`
  ) as { ok?: boolean; label?: string };
  return { ok: Boolean(value?.ok), label: String(value?.label ?? step.selector) };
}

async function uploadFile(cdp: CdpClient, selector: string, filePath: string): Promise<boolean> {
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    objectGroup: "scholarship-autofill",
    returnByValue: false
  }) as { result?: { objectId?: string } };
  const objectId = evaluated.result?.objectId;
  if (!objectId) return false;
  const node = await cdp.send("DOM.requestNode", { objectId }) as { nodeId?: number };
  if (!node.nodeId) return false;
  await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [filePath] });
  return true;
}

async function inspectPageState(cdp: CdpClient): Promise<PageState> {
  const state = await cdp.evaluate(
    `(function() {
      const text = document.body ? document.body.innerText.toLowerCase() : "";
      const visibleButtons = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']"))
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        })
        .map((element) => String(element.innerText || element.value || element.getAttribute("aria-label") || "").toLowerCase());
      return {
        loginRequired: Boolean(document.querySelector("input[type='password']")) || /\\b(sign in|log in|login)\\b/.test(text),
        reviewReady: visibleButtons.some((label) => /\\b(submit|send application|finish|complete application)\\b/.test(label)),
        blockerText: [
          /payment|credit card|application fee/.test(text) ? "Payment language detected. Review before continuing." : "",
          /signature|e-?sign/.test(text) ? "Signature language detected. Review before continuing." : "",
          /recommendation|recommender|reference request/.test(text) ? "Recommendation request language detected. Review before continuing." : ""
        ].filter(Boolean)
      };
    })()`
  ) as Partial<PageState>;
  return {
    loginRequired: Boolean(state.loginRequired),
    reviewReady: Boolean(state.reviewReady),
    blockerText: Array.isArray(state.blockerText) ? [...new Set(state.blockerText.map(String))] : []
  };
}

function resolveDocumentPath(document: DocumentRecord | undefined, baseDir: string): string {
  if (!document || document.status !== "available") return "";
  if (!document.path || document.path.startsWith("browser-local://") || document.path.startsWith("vercel-preview/")) return "";
  const resolved = path.isAbsolute(document.path) ? document.path : path.join(baseDir, document.path);
  return existsSync(resolved) ? resolved : "";
}

async function ensureChromeRunning(executable: string, userDataDir: string, port: number, launchUrl: string): Promise<void> {
  if (await chromeDebuggingAvailable(port)) return;
  chromeProcess = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    launchUrl
  ]);
  chromeProcess.on("error", () => undefined);
  chromeProcess.stderr.on("data", () => undefined);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await chromeDebuggingAvailable(port)) return;
    await delay(250);
  }
  throw new Error("Chrome did not open with remote debugging enabled.");
}

async function chromeDebuggingAvailable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function openChromeTarget(port: number, url: string): Promise<ChromeTarget> {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (created.ok) return created.json() as Promise<ChromeTarget>;
  const list = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await list.json() as ChromeTarget[];
  const target = targets.find((item) => item.webSocketDebuggerUrl);
  if (!target) throw new Error("Chrome did not expose a controllable tab.");
  return target;
}

function findChromeExecutable(): string {
  const candidates = [
    process.env.SCHOLARSHIP_CHROME_EXECUTABLE ?? "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "";
}

function validLaunchUrl(rawUrl: string): string {
  try {
    const url = new URL(String(rawUrl ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "example.org" || host === "example.com" || host === "example.net" || host === "example.test") return "";
    if (host.endsWith(".example.org") || host.endsWith(".example.test")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function unavailable(launchUrl: string, message: string): ChromeAutofillResult {
  return {
    status: "unavailable",
    sessionStatus: "waiting_for_manual_submit",
    launchUrl,
    filledFields: [],
    skippedFields: [],
    blockers: [],
    message
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  private socket: any;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: any) {
    this.socket = socket;
    socket.addEventListener("message", (event: { data: string }) => {
      const message = JSON.parse(event.data) as CdpResponse;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Chrome DevTools command failed."));
      else pending.resolve(message.result);
    });
  }

  static connect(webSocketUrl: string): Promise<CdpClient> {
    if (!webSocketUrl) return Promise.reject(new Error("Chrome DevTools target is missing a WebSocket URL."));
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) return Promise.reject(new Error("This Node runtime does not support WebSocket."));
    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(webSocketUrl);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)));
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as { result?: { value?: unknown } };
    return response.result?.value;
  }

  close(): void {
    this.socket.close();
  }
}
