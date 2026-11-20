import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Mermaid } from "@/components/Mermaid";

const renderer = vi.hoisted(() => ({
  render: vi.fn(),
  initialize: vi.fn(),
  t: (value: string) => value,
}));
vi.mock("mermaid", () => ({ default: renderer }));
      .toBeInTheDocument();
    expect(renderer.render).toHaveBeenCalledWith(expect.any(String), correctedChart);
    expect(screen.queryByText("Diagram rendering error")).not.toBeInTheDocument();
  });
});
