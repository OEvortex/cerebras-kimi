import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComposerTray } from "@/components/chat/home/ComposerTray";

vi.mock("@/shared/router/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

it("hides the Create menu when the page customization turns it off", () => {
  const onChange = vi.fn()
  render(
    <ComposerTray
      placement="down"
      create={{ value: null, onChange }}
      controls={{ skills: true, mcp: true, partners: true, preferences: true, voice: true, create: false }}
    />,
  )
  expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument()
})
