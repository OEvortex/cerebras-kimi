import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import NotebookUIView from "@/features/notebook-ui/NotebookUIView";

const PROGRAM = `root = Notebook([first, quiz, cards], "Photosynthesis")
first = Page([title, intro, formula], "The Basics")
title = Heading("How plants eat", 2)
intro = Para("Plants turn light, water and CO₂ into sugar.")
formula = Math("E = mc^2", "The energy scale")
quiz = Page([question], "Check yourself", "The Basics")
question = Quiz([{question: "Where does the Calvin cycle happen?", type: "choice", options: ["Stroma", "Thylakoid"], answer: "Stroma", explanation: "The Calvin cycle runs in the stroma."}], "Quick quiz")
cards = Page([deck], "Key terms", "The Basics")
deck = Flashcards([{front: "Chlorophyll", back: "The green pigment that captures light."}])`;

describe("NotebookUIView", () => {
  it("renders a streamed Notebook program as pages and blocks", () => {
    render(<NotebookUIView content={PROGRAM} />);
    expect(screen.getByText("Photosynthesis")).toBeTruthy();
    expect(screen.getAllByText("The Basics").length).toBeGreaterThan(0);
    expect(screen.getByText("How plants eat")).toBeTruthy();
    expect(screen.getByText(/Plants turn light, water/)).toBeTruthy();
    // Two subpages link back to the hub in the page navigation.
    expect(document.querySelectorAll(".nb-nav-link").length).toBe(3);
  });

  it("renders LaTeX as KaTeX, not raw source", () => {
    const { container } = render(<NotebookUIView content={PROGRAM} />);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
    expect(container.querySelector(".katex-html")).not.toBeNull();
  });

  it("lets the learner answer a quiz that was authored in the program", async () => {
    const user = userEvent.setup();
    render(<NotebookUIView content={PROGRAM} />);
    await user.click(screen.getByText("Stroma"));
    await user.click(screen.getByRole("button", { name: /reveal answer/i }));
    expect(screen.getByText(/The Calvin cycle runs in the stroma/)).toBeTruthy();
  });

  it("flips a flashcard authored in the program", async () => {
    const user = userEvent.setup();
    render(<NotebookUIView content={PROGRAM} />);
    expect(screen.getByText("Chlorophyll")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /flip/i }));
    expect(screen.getByText(/The green pigment that captures light/)).toBeTruthy();
  });
});
