import { beforeEach, expect, it, vi } from "vitest";
import { deleteSession } from "@/lib/session-api";
import { moveFailedSubmissions, readFailedSubmissions, storeFailedSubmission } from "@/lib/failed-submissions";

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/shared/api/client", () => ({
  asJsonOrThrow: async (response: Response) => {
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body?.detail) detail = String(body.detail);
      } catch { /* keep status line */ }
      throw new Error(detail);
    }
    return response.json();
  },
  apiUrl: (path: string) => path,
  apiFetch: (...args: unknown[]) => fixture.fetch(...args),
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fixture.fetch.mockReset();
});

it("clears only the deleted session after the server confirms deletion", async () => {
  for (const session of ["A", "B"]) {
    storeFailedSubmission(session, { content: "same text", requestSnapshot: {}, submissionId: "same-id" });
  }
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  await deleteSession("A", "workspace-A");
  expect(fixture.fetch).toHaveBeenCalledWith("/api/sessions/A?dt_workspace=workspace-A", { method: "DELETE" });
  expect(readFailedSubmissions("A")).toEqual([]);
  expect(readFailedSubmissions("B")).toHaveLength(1);
});

it("preserves recovery data if the deletion request fails", async () => {
  storeFailedSubmission("A", { content: "unsent", requestSnapshot: {}, submissionId: "pending" });
  fixture.fetch.mockResolvedValue(new Response("error", { status: 500 }));
  await expect(deleteSession("A")).rejects.toThrow("Request failed: 500");
  expect(readFailedSubmissions("A")).toHaveLength(1);
});


it("also clears the draft source of a tab-scoped session binding", async () => {
  storeFailedSubmission("draft:general", { content: "pending draft", requestSnapshot: {}, submissionId: "draft-id" });
  const set = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key.includes(".record.A:")) throw new DOMException("Quota", "QuotaExceededError");
    set(key, value);
  });
  moveFailedSubmissions("draft:general", "A", ["draft-id"]);
  expect(readFailedSubmissions("A")).toHaveLength(1);
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  await deleteSession("A");
  expect(readFailedSubmissions("A")).toEqual([]);
  expect(readFailedSubmissions("draft:general")).toEqual([]);
});


it("keeps recovery data when a successful HTTP response does not confirm deletion", async () => {
  storeFailedSubmission("A", { content: "unsent", requestSnapshot: {}, submissionId: "pending" });
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ deleted: false }), { status: 200 }));
  await expect(deleteSession("A")).rejects.toThrow("Session was not deleted");
  expect(readFailedSubmissions("A")).toHaveLength(1);
});
