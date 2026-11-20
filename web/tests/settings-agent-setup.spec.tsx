import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentSetupHelp from "@/components/settings/AgentSetupHelp";
import { copyText } from "@/lib/clipboard";
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

beforeEach(() => {
  vi.mocked(copyText).mockReset();
});

describe("Agent setup handoff", () => {
  it("copies the complete displayed guide and restores focus on Escape", async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    render(<AgentSetupHelp />);
    const trigger = screen.getByRole("button", { name: "Let your Agent help you configure" });
    trigger.focus();
    fireEvent.click(trigger);
    const prompt = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(prompt).toHaveAttribute("readonly");
    expect(prompt.value).toContain("docs-for-dev/AGENT_SETUP.md");
    expect(prompt.value).toContain("existing DeepTutor installation");
    expect(prompt.value).toContain("pending drafts");
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
    expect(copyText).toHaveBeenCalledWith(prompt.value);
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps the prompt selectable and allows retry when clipboard access fails", async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error("Clipboard blocked"));
    render(<AgentSetupHelp />);
    fireEvent.click(screen.getByRole("button", { name: "Let your Agent help you configure" }));
    const copy = screen.getByRole("button", { name: "Copy prompt" });
    fireEvent.click(copy);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not copy. Select the text above and copy it manually."));
    const prompt = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.focus(prompt);
    expect(prompt.selectionEnd - prompt.selectionStart).toBe(prompt.value.length);
    vi.mocked(copyText).mockResolvedValueOnce(undefined);
    fireEvent.click(copy);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
  });

});
