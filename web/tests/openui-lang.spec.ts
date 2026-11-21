import { describe, expect, it } from "vitest";

import {
  extractOpenUILang,
  hasOpenUILang,
  splitProgramStatements,
  toOpenUIProgram,
} from "@/lib/openui/lang";

const PROGRAM = [
  "root = Col([head])",
  'head = Title("Maxwell", "xl")',
].join("\n");

/**
 * The tutor prompt asks for a bare program, but models sometimes write a
 * sentence first. That one line used to make the whole reply unparseable: the
 * gate that chose the OpenUI renderer only matched `root` at the start of a
 * line, so the turn fell through to the Markdown renderer and the program was
 * printed as prose.
 */
describe("locating an OpenUI Lang program in a model reply", () => {
  it("finds a bare program", () => {
    expect(hasOpenUILang(PROGRAM)).toBe(true);
    expect(extractOpenUILang(PROGRAM).program).toBe(PROGRAM);
    expect(toOpenUIProgram(PROGRAM)).toBe(PROGRAM);
  });

  it("finds a program a prose prefix ran into", () => {
    const reply = `I'll lay out the derivation — what fixes what.${PROGRAM}`;
    const extraction = extractOpenUILang(reply);

    expect(hasOpenUILang(reply)).toBe(true);
    expect(extraction.program).toBe(PROGRAM);
    expect(extraction.preamble).toBe("I'll lay out the derivation — what fixes what.");
    expect(extraction.trailing).toBe("");
    expect(toOpenUIProgram(reply)).toBe(PROGRAM);
  });

  it("drops prose appended after the last statement", () => {
    const reply = `${PROGRAM}\n\nThat is the whole derivation.`;
    const extraction = extractOpenUILang(reply);

    expect(extraction.program).toBe(PROGRAM);
    expect(extraction.trailing).toBe("That is the whole derivation.");
    expect(toOpenUIProgram(reply)).toBe(PROGRAM);
  });

  it("drops a narration line between two statements", () => {
    const reply = [
      "root = Col([head, note])",
      "head = Title(\"Maxwell\", \"xl\")",
      "Now the note:",
      "note = Caption(\"Four equations.\")",
    ].join("\n");
    const extraction = extractOpenUILang(reply);

    expect(extraction.found).toBe(true);
    expect(extraction.program).not.toContain("Now the note:");
    expect(extraction.program).toContain("note = Caption");
  });

  it("reads a fenced openui-lang block", () => {
    const reply = `Here you go:\n\n\`\`\`openui-lang\n${PROGRAM}\n\`\`\`\n`;

    expect(extractOpenUILang(reply).program).toBe(PROGRAM);
    expect(extractOpenUILang(reply).preamble).toBe("Here you go:");
    expect(hasOpenUILang(reply)).toBe(true);
  });

  it("does not leave a bare fence behind as a preamble", () => {
    // Models often wrap the whole reply in a plain ``` fence instead of an
    // `openui-lang` one. The opening fence used to survive as the preamble and
    // render as an empty code block — a dark strip above every answer.
    const reply = `\`\`\`\n${PROGRAM}\n\`\`\``;
    const extraction = extractOpenUILang(reply);

    expect(extraction.found).toBe(true);
    expect(extraction.program).toBe(PROGRAM);
    expect(extraction.preamble).toBe("");
    expect(extraction.trailing).toBe("");
    expect(hasOpenUILang(reply)).toBe(true);
    expect(toOpenUIProgram(reply)).toBe(PROGRAM);
  });

  it("keeps real prose before a bare fence as the preamble", () => {
    const reply = `Here you go:\n\n\`\`\`\n${PROGRAM}\n\`\`\``;
    const extraction = extractOpenUILang(reply);

    expect(extraction.program).toBe(PROGRAM);
    expect(extraction.preamble).toBe("Here you go:");
  });

  it("keeps a reply with no program renderable as a Markdown node", () => {
    const prose = "The gradient points in the direction of greatest increase.";

    expect(hasOpenUILang(prose)).toBe(false);
    expect(toOpenUIProgram(prose)).toBe(`root = Markdown(${JSON.stringify(prose)})`);
  });

  it("does not mistake a mention of root for a program", () => {
    expect(hasOpenUILang("The root of the equation is x = 2.")).toBe(false);
    expect(extractOpenUILang("").found).toBe(false);
    expect(extractOpenUILang(null).found).toBe(false);
  });
});

describe("a program written on one line", () => {
  it("is split at statement boundaries", () => {
    const reply =
      'root = Col([head, note]) head = Title("Can\'t open it", "xl") note = Text("No content to read.", "md")';
    const extraction = extractOpenUILang(reply);

    expect(extraction.found).toBe(true);
    expect(extraction.program.split("\n")).toEqual([
      "root = Col([head, note])",
      'head = Title("Can\'t open it", "xl")',
      'note = Text("No content to read.", "md")',
    ]);
  });

  it("does not split on a `=` inside a string or a call", () => {
    const program = splitProgramStatements(
      'root = Text("a = b, and (c = d)") x = Math("E = mc^2", true)',
    );
    expect(program.split("\n")).toEqual([
      'root = Text("a = b, and (c = d)")',
      'x = Math("E = mc^2", true)',
    ]);
  });
});
