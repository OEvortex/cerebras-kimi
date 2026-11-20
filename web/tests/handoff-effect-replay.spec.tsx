import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HandoffPage from "@/app/handoff/page";

const runtime = vi.hoisted(() => ({ fetch: vi.fn(), replace: vi.fn() }));
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
  }, apiFetch: runtime.fetch, apiUrl: (url: string) => url }));
vi.mock("@/shared/router/navigation", () => ({
  useRouter: () => ({ replace: runtime.replace }),
  useSearchParams: () => new URLSearchParams("code=example-code&next=%2Fprofile"),
}));

describe("automatic handoff sign-in", () => {
  it.each([false, true])("completes a code sign-in with strict mode %s", async strict => {
    runtime.replace.mockReset();
    runtime.fetch.mockReset().mockImplementation((url: string) => Promise.resolve(
      new Response(JSON.stringify(url.endsWith("/exchange") ? { ticket: "example-ticket" } : {})),
    ));
    render(<HandoffPage />, { reactStrictMode: strict });
    await waitFor(() => expect(runtime.replace).toHaveBeenCalledWith("/profile"));
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(runtime.fetch.mock.calls[0][1].body)).toEqual({ code: "example-code" });
    expect(JSON.parse(runtime.fetch.mock.calls[1][1].body)).toEqual({ ticket: "example-ticket" });
  });

  it("does not exchange the code after unmount before the deferred start", async () => {
    runtime.fetch.mockReset();
    vi.useFakeTimers();
    try {
      const { unmount } = render(<HandoffPage />);
      unmount();
      await vi.runAllTimersAsync();
      expect(runtime.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
