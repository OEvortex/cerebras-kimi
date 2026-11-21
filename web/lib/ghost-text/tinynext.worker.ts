/// <reference lib="webworker" />
/**
 * tinynext ghost-text worker.
 *
 * Runs entirely in the browser: loads /tinynext/{config,tokenizer,model},
 * then answers "suggest" with the gray continuation shown in the composer.
 *
 *   in : { type: "warmup" }
 *        { type: "suggest", id, text }
 *   out: { type: "ready" }
 *        { type: "suggestion", id, text, error? }
 */
import * as ort from "onnxruntime-web";

import { TinyTokenizer } from "./tiny-tokenizer";
import { finalizeSuggestion } from "./suggestion";

ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
ort.env.wasm.numThreads = 1;

const BASE = "/tinynext";
// Greedy decode stops when the continuation stops looking like English.
// The old 0.4 cumulative cutoff fired on the very first token for almost
// every prompt (a 12M-param model rarely puts 40% on one token), so the
// suggestion was always empty. Token-level confidence is the useful signal;
// the cumulative one only guards against long implausible runs.
const MIN_TOKEN_PROBABILITY = 0.01;
const MIN_SEQUENCE_PROBABILITY = 0.0005;
const MAX_STEPS = 24;
const MAX_WORDS = 6;
const MAX_CHARS = 48;
const LAYERS = 8;
const HEADS = 5;
const HEAD_DIM = 64;

type Cache = { k: ort.Tensor; v: ort.Tensor } | null;

let session: ort.InferenceSession | null = null;
let tokenizer: TinyTokenizer | null = null;
let vocab = 0;
let ready = false;

async function init(): Promise<void> {
  if (ready) return;
  const [configRes, tokRes] = await Promise.all([
    fetch(`${BASE}/config.json`).then((response) => response.json()),
    fetch(`${BASE}/tokenizer.json`).then((response) => response.json()),
  ]);
  tokenizer = new TinyTokenizer(tokRes);
  vocab = Number(configRes.vocab) || Object.keys(tokRes.model?.vocab || {}).length;
  session = await ort.InferenceSession.create(`${BASE}/model.onnx`, {
    executionProviders: ["wasm"],
  });
  ready = true;
  (self as unknown as Worker).postMessage({ type: "ready" });
}

/** The graph takes `past_k` / `past_v` on the first step too, with length 0. */
function emptyCache(): { past_k: ort.Tensor; past_v: ort.Tensor } {
  const shape = [LAYERS, 1, HEADS, 0, HEAD_DIM];
  const empty = new Float32Array(0);
  return {
    past_k: new ort.Tensor("float32", empty, shape),
    past_v: new ort.Tensor("float32", empty, shape),
  };
}

async function suggest(before: string): Promise<string> {
  if (!session || !tokenizer) return "";
  const ids = tokenizer.encode(before);
  if (!ids.length) return "";

  const first = (await session.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    ...emptyCache(),
  })) as Record<string, ort.Tensor>;

  let logits: ort.Tensor = first.logits;
  let cache: Cache = { k: first.present_k, v: first.present_v };
  let out = "";
  let probability = 1;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const row = logits.data as Float32Array;
    let max = -Infinity;
    for (let index = 0; index < vocab; index += 1) {
      if (!tokenizer.specials.has(index) && row[index] > max) max = row[index];
    }
    if (!Number.isFinite(max)) break;

    let sum = 0;
    const probabilities = new Float64Array(vocab);
    for (let index = 0; index < vocab; index += 1) {
      probabilities[index] = tokenizer.specials.has(index) ? 0 : Math.exp(row[index] - max);
      sum += probabilities[index];
    }

    let top = -1;
    let topProbability = 0;
    for (let index = 0; index < vocab; index += 1) {
      const chance = probabilities[index] / sum;
      if (chance > topProbability) {
        topProbability = chance;
        top = index;
      }
    }
    if (top < 0 || topProbability < MIN_TOKEN_PROBABILITY) break;
    probability *= topProbability;
    if (probability < MIN_SEQUENCE_PROBABILITY) break;

    const text = tokenizer.tokenText(top);
    if (tokenizer.specials.has(top) || !text.trim()) break;
    out += text;
    if (
      /[.,!?;:]$/.test(text) ||
      out.length >= MAX_CHARS ||
      out.trim().split(/\s+/).length >= MAX_WORDS
    ) break;

    const result = (await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(top)]), [1, 1]),
      past_k: cache!.k,
      past_v: cache!.v,
    })) as Record<string, ort.Tensor>;
    logits = result.logits;
    cache = { k: result.present_k, v: result.present_v };
  }

  // Byte-level BPE can leave a half-written trailing word; see suggestion.ts.
  return finalizeSuggestion(out);
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as { type: string; id?: number; text?: string };
  try {
    if (message.type === "warmup") {
      await init();
      return;
    }
    if (message.type === "suggest" && typeof message.id === "number") {
      if (!ready) await init();
      const text = await suggest(message.text ?? "");
      (self as unknown as Worker).postMessage({
        type: "suggestion",
        id: message.id,
        text,
      });
    }
  } catch (error) {
    (self as unknown as Worker).postMessage({
      type: "suggestion",
      id: message.id ?? -1,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
