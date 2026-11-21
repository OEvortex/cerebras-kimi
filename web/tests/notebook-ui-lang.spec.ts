import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";

import { schema, fitSchema } from "@/features/notes/components/editor/schema";
import {
  compileNotebookProgram,
  extractNotebookUI,
  hasNotebookUI,
  toNotebookUIProgram,
} from "@/features/notebook-ui/notebook-ui-lang/lang";

const PROGRAM = `root = Notebook([water, quiz], "The Water Cycle")
water = Page([intro, facts, takeaways], "The Water Cycle")
intro = Para("Water moves in a continuous loop with $E = mc^2$ energy.")
facts = Bullets(["Evaporation", "Condensation"])
takeaways = Heading("Key takeaways", 2)
quiz = Page([questions], "Water Cycle Quiz", "The Water Cycle")
questions = Quiz([{question: "Which process lifts water?", type: "choice", options: ["Runoff", "Evaporation"], answer: "Evaporation", explanation: "Heat from the sun."}])`;

describe("notebook-ui-lang", () => {
  it("extracts a Notebook program with prose around it", () => {
    const result = extractNotebookUI(`Sure — here is the notebook.\n${PROGRAM}\nDone.`);
    expect(result.found).toBe(true);
    expect(result.program).toContain("root = Notebook(");
    expect(result.program).not.toContain("Sure — here is the notebook.");
  });

  it("does not claim non-notebook text is a program", () => {
    expect(hasNotebookUI("Just a normal answer.")).toBe(false);
    expect(hasNotebookUI('root = Col([Text("hello")])')).toBe(false);
  });

  it("passes through a partial program while it streams", () => {
    const partial = "root = Notebook([water])\nwater = Page([";
    expect(toNotebookUIProgram(partial)).toBe(partial);
  });

  it("compiles pages, blocks and learning data", () => {
    const plan = compileNotebookProgram(PROGRAM);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("The Water Cycle");
    expect(plan!.pages.map((page) => page.title)).toEqual([
      "The Water Cycle",
      "Water Cycle Quiz",
    ]);
    expect(plan!.pages[1].parentTitle).toBe("The Water Cycle");

    const blocks = plan!.pages[0].blocks;
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "bulletListItem",
      "bulletListItem",
      "heading",
    ]);

    const quizBlock = plan!.pages[1].blocks[0];
    expect(quizBlock.type).toBe("learning");
    const data = JSON.parse(String(quizBlock.props.data));
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].question_type).toBe("choice");
    expect(data.questions[0].correct_answer).toBe("B");
    expect(data.questions[0].options).toEqual({ A: "Runoff", B: "Evaporation" });
  });

  it("gives every compiled block a unique valid id", () => {
    const plan = compileNotebookProgram(PROGRAM)!;
    const ids = plan.pages.flatMap((page) => page.blocks.map((block) => block.id));
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[\w-]{1,128}$/));
  });

  it("returns null for a program without a usable page", () => {
    expect(compileNotebookProgram("root = Notebook([])")).toBeNull();
  });

  it("emits tables BlockNote can open as initialContent", () => {
    const program = `root = Notebook([p], "N")
p = Page([t], "P")
t = Table(["Stage", "Output"], [["Light", "ATP"], ["Dark", "Sugar"]])`;
    const plan = compileNotebookProgram(program)!;
    const table = plan.pages[0].blocks[0];
    expect((table.content as any).type).toBe("tableContent");
    for (const row of (table.content as any).rows) {
      for (const cell of row.cells) expect(Array.isArray(cell)).toBe(true);
    }

    // The real regression: opening a page with this block used to throw
    // "Error creating document from blocks passed as `initialContent`".
    const editor = BlockNoteEditor.create({
      schema,
      initialContent: fitSchema(plan.pages[0].blocks) as any,
    });
    expect(editor.document.length).toBe(1);
    editor._tiptapEditor.destroy();
  });
});
