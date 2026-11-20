import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const component = readFileSync(
  path.resolve(process.cwd(), "components/reading/ReadingExtensionBar.tsx"),
  "utf8",
);
const pane = readFileSync(
  path.resolve(process.cwd(), "components/reading/ReaderPane.tsx"),
  "utf8",
);
const speechHook = readFileSync(
  path.resolve(process.cwd(), "components/reading/use-read-aloud-speech.ts"),
  "utf8",
);
const api = readFileSync(
  path.resolve(process.cwd(), "lib/reading-api.ts"),
  "utf8",
);

test("the Reader toolbar is empty when no extension is installed", () => {
  assert.match(component, /if \(actions\.length === 0\) return null/);
  assert.match(pane, /<ReadingExtensionBar/);
});

test("extension results never inject browser JavaScript or raw HTML", () => {
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|eval\(|new Function/);
  assert.match(component, /String\(result\.payload\.body/);
});

test("the browser sends a locator and selection, not trusted visible text", () => {
  assert.match(api, /runReadingExtension/);
  assert.doesNotMatch(api, /visible_text\?: string/);
});

test("reading quiz answers send only the selected index", () => {
  assert.match(api, /export async function submitReadingQuizAnswers/);
  assert.match(
    api,
    /answers: payload\.answers\.map\(\(row\) => \(\{[\s\S]*question_id: row\.question_id,[\s\S]*selected_index: row\.selected_index,[\s\S]*\}\)\)/,
  );
  const submitFn = api.slice(api.indexOf("submitReadingQuizAnswers"));
  assert.doesNotMatch(submitFn, /correct_choice_index/);
  assert.match(component, /submitReadingQuizAnswers\(materialId,/);
  assert.match(component, /selected_index: choiceIndex/);
  const persistStart = component.indexOf("function persistAnswer");
  const persistEnd = component.indexOf("questions.map", persistStart);
  assert.notEqual(persistStart, -1);
  assert.notEqual(persistEnd, -1);
  assert.doesNotMatch(
    component.slice(persistStart, persistEnd),
    /correct_choice_index/,
  );
  assert.match(pane, /sessionId=\{sessionId\}/);
});

test("a malformed extension catalog cannot crash the whole reader", () => {
  assert.match(api, /if \(!Array\.isArray\(payload\)\) return \[\]/);
  assert.match(
    api,
    /Array\.isArray\(\(row as ReadingExtensionManifest\)\.actions\)/,
  );
});

test("browser speech is stoppable and cannot continue after navigation", () => {
  assert.match(component, /useReadAloudSpeech\(\)/);
  assert.match(
    component,
    /useEffect\(\(\) => stopSpeaking, \[locator, materialId, stopSpeaking\]\)/,
  );
  assert.match(speechHook, /const \[speaking, setSpeaking\] = useState\(false\)/);
  assert.match(speechHook, /window\.speechSynthesis\?\.cancel\(\)/);
  assert.match(speechHook, /utterance\.onend = \(\) => \{/);
  assert.match(speechHook, /utterance\.onerror = \(\) => \{/);
  assert.match(component, /\[locator, materialId, stopSpeaking\]/);
  assert.match(component, /aria-label=\{"Stop reading aloud"\}/);
});

test("the built-in read-aloud action has an explicit label", () => {
  assert.match(
    component,
    /extensionId === "read_aloud" && actionId === "read"/,
  );
  assert.match(component, /"Stop reading aloud"/);
});

test("the built-in study-guidance action is localized", () => {
  assert.match(component, /function builtInActionLabel/);
  assert.match(
    component,
    /extensionId === "guided_learning" && actionId === "guide"/,
  );
  assert.match(component, /"Guide me"/);
});

test("study-guidance steps are visible in the result card", () => {
  assert.match(component, /result\.payload\.steps/);
  assert.match(component, /steps\.map\(\(step, index\) =>/);
  assert.match(component, /list-decimal/);
});

test("the built-in vocabulary action is localized", () => {
  assert.match(
    component,
    /extensionId === "vocabulary" && actionId === "explain"/,
  );
  assert.match(component, /"Explain vocabulary"/);
});

test("vocabulary terms are visible in the result card", () => {
  assert.match(component, /result\.payload\.terms/);
  assert.match(component, /String\(term\.term \|\| ""\)/);
  assert.match(component, /terms\.map\(\(term, index\) =>/);
  assert.match(component, /<dt className="font-medium">\{term\.term\}<\/dt>/);
  assert.match(component, /\{term\.meaning\}/);
  assert.match(component, /\{term\.usage\}/);
});

test("the built-in reading-quiz action is localized", () => {
  assert.match(component, /extensionId === "quiz" && actionId === "start"/);
  assert.match(component, /"Quiz me"/);
});

test("reading quizzes reveal grading only after the learner answers", () => {
  assert.doesNotMatch(component, /correct_choice_index/);
  assert.match(component, /const \[answers, setAnswers\] = useState/);
  assert.match(component, /aria-pressed=\{selected === choiceIndex\}/);
  assert.match(component, /verdicts\[key\]/);
  assert.match(component, /"Correct" : "Incorrect"/);
});

test("the built-in translation actions have explicit target languages", () => {
  assert.match(
    component,
    /extensionId === "translation" && actionId === "translate_en"/,
  );
  assert.match(
    component,
    /extensionId === "translation" && actionId === "translate_zh"/,
  );
  assert.match(component, /"Translate to English"/);
});

test("translation results are rendered as text in the result card", () => {
  assert.match(component, /String\(result\.payload\.translation \|\| ""\)/);
  assert.match(component, /result\.payload\.alternatives/);
  assert.match(component, /String\(result\.payload\.note \|\| ""\)/);
  assert.match(component, /\{translation\.translation\}/);
  assert.match(component, /\{translation\.note\}/);
  assert.match(component, /translation\.alternatives\.map/);
});
