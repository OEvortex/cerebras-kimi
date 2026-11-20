export const INSTALL_HINTS: Record<string, string> = {
  graphrag: "pip install 'deeptutor[graphrag]'",
  lightrag: "pip install 'deeptutor[rag-lightrag]'",
};

// Mode one-liners, keyed by `${engineId}:${mode}`, in English.
export const MODE_DESCRIPTIONS: Record<string, string> = {
  "graphrag:local":
    "Entity-focused retrieval over the relevant local subgraph — fast and economical.",
  "graphrag:global":
    "Map-reduce over global community summaries — best for broad, thematic questions.",
  "graphrag:drift":
    "Local retrieval with dynamic follow-ups — balances precision and coverage.",
  "graphrag:basic": "Plain vector retrieval — the lightest option.",
  "lightrag:naive": "Plain vector retrieval, without the knowledge graph.",
  "lightrag:local": "Local context focused on the most relevant entities.",
  "lightrag:global": "Theme-level retrieval over global relationships.",
  "lightrag:hybrid":
    "Combines local and global retrieval — a solid general default.",
  "lightrag:mix": "Fuses knowledge-graph and vector retrieval.",
  "lightrag-server:naive":
    "Plain vector retrieval, without the knowledge graph.",
  "lightrag-server:local":
    "Local context focused on the most relevant entities.",
  "lightrag-server:global": "Theme-level retrieval over global relationships.",
  "lightrag-server:hybrid":
    "Combines local and global retrieval — a solid general default.",
  "lightrag-server:mix":
    "Fuses knowledge-graph and vector retrieval — the server's default.",
};

// Model kinds each engine needs (for the in-place pickers). "vision" isn't a
// catalog service — it rides on the active chat model. LightRAG owns its role
// models separately and only uses the shared embedding selection here.
export const ENGINE_MODEL_KINDS: Record<string, ("llm" | "embedding")[]> = {
  llamaindex: ["embedding"],
  pageindex: [],
  "pageindex-oss": ["llm"],
  graphrag: ["llm", "embedding"],
  lightrag: ["embedding"],
  "lightrag-server": [],
  weknora: [],
};

export const MODEL_KIND_LABEL: Record<string, string> = {
  llm: "Chat model",
  embedding: "Embedding model",
};

// Free-form GraphRAG/LightRAG answer styles. Any string is accepted server-side;
// these are the common presets.
export const RESPONSE_TYPE_PRESETS = [
  "Multiple Paragraphs",
  "Single Paragraph",
  "Single Sentence",
  "List of 3-7 Points",
  "Multiple-Page Report",
];

// Prerequisites prose per engine (English source doubles as i18n key).
export const ENGINE_PREREQUISITES: Record<string, string> = {
  llamaindex:
    "Local vector engine — works out of the box. Each knowledge base uses its selected embedding model; install the optional BM25 package to enable hybrid retrieval.",
  pageindex:
    "Hosted engine: documents are uploaded to PageIndex's servers and the chat agent reads them through the PageIndex MCP tools. Requires an API key; PDF, Office, text and Markdown formats.",
  "pageindex-oss":
    "Local chunkless and vectorless indexing. Accepts PDF files and uses the globally active chat model credential for indexing; the index remains readable after model changes.",
  graphrag:
    "Local knowledge-graph retrieval. Needs the optional dependency installed; indexing is LLM-heavy. Requires an active chat model and embedding model.",
  lightrag:
    "Graph + vector retrieval with multimodal parsing. Needs the optional dependency installed; indexing is LLM-heavy. Requires active chat and embedding models; multimodal also needs a vision model.",
  "lightrag-server":
    "Server engine: retrieval runs on a standalone LightRAG service you operate. Save a reusable URL here, test it, then override it only when a knowledge base needs another server.",
  ima: "Hosted engine: the library lives in Tencent IMA and DeepTutor keeps no copy. Requires an IMA Client ID and API key. Chat searches it, browses its documents, reads full sources, and — only when you ask — collects a web page or saves a note.",
};
