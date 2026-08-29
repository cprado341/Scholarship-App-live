import { randomUUID } from "node:crypto";
import type { DocumentRecord, ID } from "../types.ts";

export interface PrivateBlobDescriptor {
  pathname: string;
  contentType: string;
  sizeBytes: number;
}

export function privateDocumentPath(input: {
  familyId: ID;
  studentId: ID;
  documentType: DocumentRecord["type"];
  fileName: string;
}): string {
  const safeName = input.fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "document";
  return `families/${input.familyId}/students/${input.studentId}/${input.documentType}/${randomUUID()}-${safeName}`;
}

export function documentRecordFromPrivateBlob(input: {
  id: ID;
  familyId: ID;
  studentId: ID;
  type: DocumentRecord["type"];
  name: string;
  blob: PrivateBlobDescriptor;
  uploadedAt: string;
}): DocumentRecord {
  return {
    id: input.id,
    familyId: input.familyId,
    studentId: input.studentId,
    type: input.type,
    category: input.type,
    name: input.name,
    path: input.blob.pathname,
    storageProvider: "vercel_blob",
    blobPath: input.blob.pathname,
    contentType: input.blob.contentType,
    sizeBytes: input.blob.sizeBytes,
    status: "available",
    uploadedAt: input.uploadedAt
  };
}

export function assertPrivateBlobConfigured(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for SaaS private document storage.");
  }
}
