/// <reference lib="webworker" />
/**
 * tinynext ghost-text worker.
 *
 * Loads paperweight/tinynext (v2, model_int8.onnx) + tokenizer.json from
 * /tinynext/ and answers "suggest" requests with the gray continuation the
 * composer shows. Protocol:
 *   in : { type: "warmup" }
 *        { type: "suggest", id: number, text: string }
 *   out: { type: "ready" }
 *        { type: "suggestion", id: number, text: string }   // "" = stay quiet
 */
import * as ort from "onnxruntime-web";
import { Tokenizer } from "tokenizers";

ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

const BASE = "/tinynext";
const CUTOFF = 0.4;
const MAX_WORDS = 6;
const MAX_CHARS = 48;
const MIN_CHARS = 4;

type Cache = { k: ort.Tensor; v: ort.Tensor } | null;

let session: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;
let vocab = 0;
let tokenTexts: string[] = [];
const stopIds = new Set<number>();
let ready = false;

async function init() {
  if (ready) return;
  const [configRes, tokRes] = await Promise.all([
    fetch(`${BASE}/config.json`).then((r) => r.json()),
    fetch(`${BASE}/tokenizer.json`).then((r) => r.text()),
  ]);
  tokenizer = await Tokenizer.fromString(tokRes);
  vocab = configRes.vocab;
  const special = Object.keys(configRes.special_tokens ?? {}).length || 4;
  for (let i = 0; i < special; i++) stopIds.add(i);
  tokenTexts = await Promise.all(
    Array.from({ length: vocab }, (_, i) =>
      i >= special
        ? Promise.resolve(tokenizer!.decode([i], false))
        : Promise.resolve(""),
    ),
  );
  session = await ort.InferenceSession.create(`${BASE}/model.onnx`, {
    executionProviders: ["wasm"],
  });
  ready = true;
  (self as unknown as Worker).postMessage({ type: "ready" });
}

function emptyCache(seqLen: number): { k: ort.Tensor; v: ort.Tensor } {
  const shape = [8, 1, 5, seqLen, 64];
  return {
    k: new ort.Tensor("float32", new Float32Array(8 * 1 * 5 * seqLen * 64), shape),
    v: new ort.Tensor("float32", new Float32Array(8 * 1 * 5 * seqLen * 64), shape),
  };
}

async function suggest(before: string): Promise<string> {
  if (!session || !tokenizer) return "";
  const ids = (await tokenizer.encode(before)).ids;
  if (!ids.length) return "";

  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    ...emptyCache(0),
  };
  const first = await session.run(feeds);
  let logits = first.logits;
  let cache: Cache = { k: first.present_k, v: first.present_v };
  let out = "";
  let prob = 1;

  for (let step = 0; step < 30; step++) {
    const row = logits.data as Float32Array;
    // softmax over vocab, specials masked
    let max = -Infinity;
    for (let i = 0; i < vocab; i++) {
      if (!stopIds.has(i) && row[i] > max) max = row[i];
    }
    let sum = 0;
    const probs = new Float64Array(vocab);
    for (let i = 0; i < vocab; i++) {
      probs[i] = stopIds.has(i) ? 0 : Math.exp(row[i] - max);
      sum += probs[i];
    }
    let top = -1;
    let topP = 0;
    for (let i = 0; i < vocab; i++) {
      const p = probs[i] / sum;
      if (p > topP) {
        topP = p;
        top = i;
      }
    }
    if (top < 0 || topP < 0.05) break;
    prob *= topP;
    if (prob < CUTOFF) break;
    const text = tokenTexts[top] ?? "";
    if (!text.trim() || stopIds.has(top)) break;
    out += text;
    if (/[.,!?;:]$/.test(text) || out.length >= MAX_CHARS || out.trim().split(/\s+/).length >= MAX_WORDS) break;

    const nextFeeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(top)]), [1, 1]),
      past_k: cache!.k,
      past_v: cache!.v,
    };
    const step = await session.run(nextFeeds);
    logits = step.logits;
    cache = { k: step.present_k, v: step.present_v };
  }

  // Keep only whole words; need >= MIN_CHARS to bother the user.
  const trimmed = out.includes(" ") ? out.slice(0, out.lastIndexOf(" ") + 1).trimEnd() : out;
  return trimmed.length >= MIN_CHARS ? trimmed : "";
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as { type: string; id?: number; text?: string };
  try {
    if (msg.type === "warmup") {
      await init();
      return;
    }
    if (msg.type === "suggest" && typeof msg.id === "number") {
      if (!ready) await init();
      const text = await suggest(msg.text ?? "");
      (self as unknown as Worker).postMessage({ type: "suggestion", id: msg.id, text });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "suggestion",
      id: msg.id ?? -1,
      text: "",
      error: String(err),
    });
  }
};
