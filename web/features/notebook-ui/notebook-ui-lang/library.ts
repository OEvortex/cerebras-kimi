"use client";

import { createLibrary } from "@openuidev/react-lang";

import { notebookComponents } from "./components";
import { notebookFunctions } from "./functions";

/**
 * The component library behind notebook-ui-lang. It is deliberately separate
 * from the chat's OpenUI library: a notebook program describes pages, learning
 * blocks and LaTeX, not a conversational card layout.
 */
export const notebookLibrary = createLibrary({
  components: notebookComponents,
  functions: notebookFunctions,
  root: "Notebook",
});
