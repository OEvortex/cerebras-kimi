import { apiFetch, apiUrl } from "@/shared/api/client";

const BASE = "/api";

export interface CoWriterDocumentSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  preview: string;
}

export interface CoWriterDocument {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Request failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}









export async function deleteCoWriterDocument(docId: string): Promise<boolean> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}`),
    {
      method: "DELETE",
    },
  );
  const data = await jsonOrThrow<{ deleted: boolean }>(res);
  return Boolean(data?.deleted);
}

export async function importCoWriterDocx(
  file: File,
): Promise<CoWriterDocument> {
  const body = new FormData();
  body.append("file", file);
  const res = await apiFetch(apiUrl(`${BASE}/documents/import/docx`), {
    method: "POST",
    body,
  });
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function exportCoWriterDocx(payload: {
  title: string;
  content: string;
}): Promise<Blob> {
  const res = await apiFetch(apiUrl(`${BASE}/documents/export/docx`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload.title ?? "",
      content: payload.content ?? "",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Request failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return res.blob();
}
