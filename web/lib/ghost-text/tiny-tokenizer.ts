/**
 * Minimal browser-only GPT-2 byte-level BPE tokenizer.
 *
 * The ghost-text worker used to import `tokenizers`, a NAPI-RS package that
 * needs node:fs and .node binaries — it can never load in a Web Worker. This
 * implements the subset tinynext needs from tokenizer.json: GPT-2 byte-level
 * pre-tokenisation, BPE merges, and decoding back to bytes.
 */

type TokenizerJson = {
  model: {
    vocab: Record<string, number>;
    merges: string[] | [string, string][];
  };
};

const BYTE_PATTERN =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function byteMaps(): { encode: Map<number, string>; decode: Map<string, number> } {
  const printable = Array.from(
    "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
  ).map((char) => char.charCodeAt(0));
  const bytes = [...printable];
  const encoded: string[] = printable.map((byte) => String.fromCharCode(byte));
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (bytes.includes(byte)) continue;
    bytes.push(byte);
    encoded.push(String.fromCharCode(256 + extra));
    extra += 1;
  }
  return {
    encode: new Map(bytes.map((byte, index) => [byte, encoded[index]])),
    decode: new Map(encoded.map((char, index) => [char, bytes[index]])),
  };
}

const { encode: byteToChar, decode: charToByte } = byteMaps();

export class TinyTokenizer {
  private vocab: Map<string, number>;
  private idToToken: string[];
  private merges: Map<string, number>;
  private specialIds: Set<number>;
  private specialTokens: { token: string; id: number }[];

  constructor(json: TokenizerJson) {
    this.vocab = new Map(Object.entries(json.model.vocab));
    this.idToToken = Array.from({ length: Object.keys(json.model.vocab).length }, () => "");
    for (const [token, id] of this.vocab) this.idToToken[id] = token;
    this.merges = new Map();
    const merges = json.model.merges || [];
    merges.forEach((merge, rank) => {
      const pair = Array.isArray(merge) ? merge.join(" ") : merge;
      this.merges.set(pair, rank);
    });
    this.specialTokens = Object.entries(json.model.vocab)
      .filter(([token]) => token.startsWith("<|") && token.endsWith("|>"))
      .map(([token, id]) => ({ token, id }))
      .sort((left, right) => right.token.length - left.token.length);
    this.specialIds = new Set(this.specialTokens.map(({ id }) => id));
  }

  get specials(): Set<number> {
    return this.specialIds;
  }

  tokenText(id: number): string {
    const token = this.idToToken[id] || "";
    let out = "";
    for (const char of token) {
      const byte = charToByte.get(char);
      out += byte === undefined ? char : String.fromCharCode(byte);
    }
    return out;
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    // Special tokens are matched literally, never passed through byte-level BPE.
    let cursor = 0;
    while (cursor < text.length) {
      const special = this.specialTokens.find(({ token }) => text.startsWith(token, cursor));
      if (special) {
        ids.push(special.id);
        cursor += special.token.length;
        continue;
      }
      const next = this.specialTokens
        .map(({ token }) => text.indexOf(token, cursor))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      const end = next ?? text.length;
      this.encodeSegment(text.slice(cursor, end), ids);
      cursor = end;
    }
    return ids;
  }

  private encodeSegment(segment: string, ids: number[]): void {
    for (const match of segment.matchAll(BYTE_PATTERN)) {
      const piece = match[0];
      const unicode = Array.from(piece)
        .flatMap((char) => Array.from(char))
        .map((char) => byteToChar.get(char.charCodeAt(0)) ?? char)
        .join("");
      const merged = this.bpe(unicode);
      for (const token of merged) {
        const id = this.vocab.get(token);
        if (id === undefined) continue;
        ids.push(id);
      }
    }
  }

  private bpe(piece: string): string[] {
    let word = Array.from(piece);
    while (word.length > 1) {
      let bestRank = Infinity;
      let bestIndex = -1;
      for (let index = 0; index < word.length - 1; index += 1) {
        const rank = this.merges.get(`${word[index]} ${word[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) break;
      word = [
        ...word.slice(0, bestIndex),
        word[bestIndex] + word[bestIndex + 1],
        ...word.slice(bestIndex + 2),
      ];
    }
    return word;
  }

  decode(ids: number[]): string {
    return ids.map((id) => this.tokenText(id)).join("");
  }
}
