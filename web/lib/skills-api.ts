import { apiFetch, apiUrl as baseApiUrl } from "@/shared/api/client";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";
import { asJsonOrThrow as asJson } from "@/shared/api/client";

function skillWorkspace(): string {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("skill_workspace") ?? "";
}

function apiUrl(path: string): string {
  const url = baseApiUrl(path);
  const scope = skillWorkspace();
  return scope ? `${url}${url.includes("?") ? "&" : "?"}skill_workspace=${encodeURIComponent(scope)}` : url;
}

const SKILLS_CACHE_PREFIX = "skills:";
const SKILL_TAGS_CACHE_KEY = `${SKILLS_CACHE_PREFIX}tags`;

export type SkillSource = "user" | "builtin" | "admin";

export interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
  source?: SkillSource;
  read_only?: boolean;
}

export interface SkillDetail extends SkillInfo {
  content: string;
}

export interface CreateSkillPayload {
  name: string;
  description: string;
  content: string;
  tags?: string[];
}

export interface UpdateSkillPayload {
  description?: string;
  content?: string;
  rename_to?: string;
  tags?: string[];
}

function normalizeSource(raw: unknown): SkillSource {
  return raw === "builtin" || raw === "admin" ? raw : "user";
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}





export interface InstalledSkill {
  name: string;
  version: string;
  verdict: { status: string; detail: string };
}

/**
 * Import a hub skill (e.g. from EduHub) into the caller's own skill layer.
 * `ref` is a `<hub>:<slug>[@version]` reference — the EduHub import flow always
 * builds an `eduhub:` ref. Surfaces the hub's security verdict so callers can
 * warn on `unknown`/`suspicious` packages.
 */


// ── EduHub / hub browsing ───────────────────────────────────────────────
// Powers the in-app "Import from EduHub" browser. The backend proxies the
// hub's public catalog (no login, no iframe), so the panel can render hub
// skills in DeepTutor's own UI and download them with one click.

export interface HubSkillListing {
  slug: string;
  name: string;
  summary: string;
  version: string;
  downloads: number;
  stars: number;
  owner: string;
  ownerUrl: string;
}

export interface HubCatalog {
  hub: string;
  /** The hub's website origin (for a "view on EduHub" link out). */
  webUrl: string;
  skills: HubSkillListing[];
}

export interface HubSkillDetail extends HubSkillListing {
  content: string;
  tags: string[];
  /** Direct link to this skill's page on the hub site. */
  webUrl: string;
}

function normalizeHubListing(item: Record<string, unknown>): HubSkillListing {
  return {
    slug: String(item?.slug ?? ""),
    name: String(item?.name ?? item?.slug ?? ""),
    summary: String(item?.summary ?? ""),
    version: String(item?.version ?? ""),
    downloads: Number(item?.downloads ?? 0),
    stars: Number(item?.stars ?? 0),
    owner: String(item?.owner ?? ""),
    ownerUrl: String(item?.owner_url ?? ""),
  };
}

/** List skills available on a hub (default EduHub). `query` filters server-side. */


/** Full metadata + rendered SKILL.md body for one hub skill. */
















export function invalidateSkillsCache() {
  invalidateClientCache(SKILLS_CACHE_PREFIX);
}
