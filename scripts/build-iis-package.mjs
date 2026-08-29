import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outDir = path.join(repoRoot, "dist", "scholarship-agent-iis");

const includeFiles = [
  ".env.example",
  "README.md",
  "DEPLOYMENT.md",
  "package.json",
  "tsconfig.json",
  "next-env.d.ts",
  "middleware.ts",
  "vercel.json",
  "web.config"
];

const includeDirs = [
  "src",
  "public",
  "api",
  "app",
  "docs",
  "iis",
  "scripts"
];

const ignoredNames = new Set([
  ".git",
  ".local",
  "dist",
  "node_modules",
  "logs"
]);

const ignoredRelativeFiles = new Set([
  path.normalize("data/app.sqlite"),
  path.normalize("iis/scholarship-agent.env.cmd")
]);

function relativeFromRoot(sourcePath) {
  return path.normalize(path.relative(repoRoot, sourcePath));
}

async function exists(pathname) {
  try {
    await stat(pathname);
    return true;
  } catch {
    return false;
  }
}

async function copyPath(relativePath) {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(outDir, relativePath);
  if (!(await exists(source))) return;

  await cp(source, target, {
    recursive: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      const rel = relativeFromRoot(sourcePath);
      if (ignoredNames.has(baseName)) return false;
      if (ignoredRelativeFiles.has(rel)) return false;
      return true;
    }
  });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of includeFiles) {
  await copyPath(file);
}

for (const dir of includeDirs) {
  await copyPath(dir);
}

await mkdir(path.join(outDir, "data", "documents"), { recursive: true });
const documentsKeep = path.join(repoRoot, "data", "documents", ".gitkeep");
if (existsSync(documentsKeep)) {
  await cp(documentsKeep, path.join(outDir, "data", "documents", ".gitkeep"));
}

await writeFile(
  path.join(outDir, "IIS-PACKAGE.txt"),
  [
    "Scholarship Agent IIS Package",
    "",
    "1. Copy this folder to a Windows Server path such as C:\\Sites\\ScholarshipAgent.",
    "2. Copy iis\\scholarship-agent.env.example.cmd to iis\\scholarship-agent.env.cmd and edit secrets.",
    "3. Run iis\\install-service.ps1 from elevated PowerShell to install the Node service.",
    "4. Run iis\\install-iis-site.ps1 from elevated PowerShell to create the IIS reverse-proxy site.",
    "5. Add an HTTPS binding and certificate before public use.",
    "6. To share Admin access, follow docs\\share-iis-admin-user.md.",
    "",
    "Full instructions: docs\\iis-deployment.md",
    ""
  ].join("\r\n")
);

console.log(`Built IIS package at ${outDir}`);
