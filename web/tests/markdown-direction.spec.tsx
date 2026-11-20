import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SimpleMarkdownRenderer from "@/components/common/SimpleMarkdownRenderer";


describe("Markdown reading direction", () => {
  it("lets each paragraph take the direction of its own text", () => {
    render(<SimpleMarkdownRenderer content={"مرحبا بالعالم\n\nHello world"} variant="prose" />);
    expect(screen.getByText("مرحبا بالعالم")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Hello world")).toHaveAttribute("dir", "ltr");
  });

  it("covers headings, list items, quotes and table cells", () => {
    const { container } = render(
      <SimpleMarkdownRenderer
        content={"# عنوان\n\n- عنصر\n\n> اقتباس\n\n| أ |\n| - |\n| ب |"}
        variant="prose"
      />,
    );
    for (const selector of ["h1", "li", "blockquote", "th", "td"]) {
      expect(container.querySelector(selector)).toHaveAttribute("dir", "ltr");
    }
    expect(container.querySelector("table")).not.toHaveAttribute("dir");
    expect(container.querySelector(".md-renderer")).not.toHaveAttribute("dir");
  });
});


it("isolates code nested inside RTL prose", () => {
  const { container } = render(<SimpleMarkdownRenderer content={"> مرحبا\n>\n> ```js\n> x = 1;\n> y = 2;\n> ```\n\n- عربي `x + y`"} variant="prose" />);
  for (const code of container.querySelectorAll("code")) expect(code).toHaveAttribute("dir", "ltr");
  expect(container.querySelector("blockquote")).toHaveAttribute("dir", "ltr");
});
