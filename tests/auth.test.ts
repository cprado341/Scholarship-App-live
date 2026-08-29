import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../src/auth.ts";
import { AppRepository } from "../src/db.ts";

function withRepo(fn: (repo: AppRepository) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scholarship-auth-"));
    const repo = new AppRepository({ dbPath: path.join(dir, "test.sqlite"), baseDir: dir, key: randomBytes(32) });
    try {
      await fn(repo);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("password hashes verify only the original password", () => {
  const encoded = hashPassword("correct horse battery staple");

  assert.equal(verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(verifyPassword("wrong password", encoded), false);
});

test(
  "default portal user can sign in and resolve a family-scoped session",
  withRepo((repo) => {
    const hint = repo.getPortalCredentialsHint();
    const session = repo.authenticateUser(hint.email, hint.password);

    assert.ok(session);
    assert.equal(session.user.familyId, repo.getDefaultFamilyId());

    const user = repo.getUserBySessionToken(session.token);
    assert.equal(user?.email, hint.email);

    repo.deleteSessionByToken(session.token);
    assert.equal(repo.getUserBySessionToken(session.token), undefined);
  })
);
