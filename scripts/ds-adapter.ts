/**
 * ds-adapter.ts — deterministic adapter from pipeline engine output → design-system
 * component shapes for the ardur.ai homepage (poc/design-system branch).
 *
 * Reads:
 *   .artifacts/latest/top10.json    — cross-topic global top-10 signals
 *   .artifacts/latest/ranking.json  — factsByCluster (extracted facts per cluster)
 *
 * Writes:
 *   .artifacts/latest/ds-home.json  — ready-to-import data for SignalRadar,
 *                                     SignalGraph, SignalTicker, and RankRow
 *
 * 0 AI tokens: every transform is deterministic string manipulation.
 *
 * Usage:
 *   node --experimental-strip-types scripts/ds-adapter.ts
 *   node --experimental-strip-types scripts/ds-adapter.ts --top10 <path> --out <path>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (flag: string, fallback: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const top10Path = getArg('--top10', join(REPO_ROOT, '.artifacts/latest/top10.json'));
const rankingPath = getArg('--ranking', join(REPO_ROOT, '.artifacts/latest/ranking.json'));
const graphPath = getArg('--graph', join(REPO_ROOT, '.artifacts/latest/graph.json'));
const projectsPath = getArg('--projects', join(REPO_ROOT, '.artifacts/latest/projects.json'));
const outPath = getArg('--out', join(REPO_ROOT, '.artifacts/latest/ds-home.json'));

// ---------------------------------------------------------------------------
// Types (engine output)
// ---------------------------------------------------------------------------

interface EngineRef {
  source: string;
  sourceDomain: string;
  tier: string;
  url: string;
  title: string;
  publishedAt: string;
}

interface EngineScore {
  corroboration: number;
  credibility: number;
  interaction: number;
  technicalSignificance: number;
  recency: number;
  diversity: number;
  total: number;
}

interface EngineSignal {
  rank: number;
  clusterId: string;
  topic: string;
  topicLabel: string;
  headline: string;
  score: EngineScore;
  sourceQuality: string;
  confidence: string;
  references: EngineRef[];
  delta?: { previousRank: number | null; movement: string };
  carriedOver?: boolean;
  sourceDocIds?: string[];
  /** Rev 4: stable 8-char SHA-256 prefix of headline. */
  signalId?: string;
  /** Rev 4: story-specific one-sentence lede from top10 engine (0 AI tokens). */
  summary?: string;
}

interface GraphLink {
  a: string;
  b: string;
  relation: string;
  weight: number;
}

interface EngineFact {
  id: string;
  topic: string;
  clusterId: string;
  statement: string;
  quantity?: { metric: string; value: number };
  entities: string[];
}

// ---------------------------------------------------------------------------
// Types (DS output)
// ---------------------------------------------------------------------------

/** Unified DS signal shape — superset of RadarSignal, SignalNode, TickerSignal, RankRow props. */
export interface DsSignal {
  /** Stable 8-char signalId from engine (rev 4) or cycle-scoped "s1"…"s10" fallback. */
  id: string;
  /** signalId from the top10 engine (SHA-256 prefix). Absent on rev-3 data. */
  signalId?: string;
  rank: number;
  /** Decoded headline (no HTML entities). */
  title: string;
  /** Story-specific summary from headline + refs + facts. Zero AI tokens. */
  summary: string;
  /** Topic slug (ai | kubernetes | platform | security | models). */
  topic: string;
  /** Human-readable topic label. */
  topicLabel: string;
  /** Unique source count (deduplicated by title). */
  sources: number;
  /** 0–1 composite score (higher = stronger signal; radar: closer to center). */
  score: number;
  /** "High" | "Medium" | "Low" */
  confidence: string;
  /** Best external URL (first unique reference). */
  href: string;
  /** RankRow kicker (= topicLabel). */
  kicker: string;
  /** RankRow trailing meta chip, e.g. "6 sources". */
  meta: string;
  /** Rank movement: "+N", "-N", "NEW", or "→". */
  delta: string;
}

export interface RepoCardData {
  name: string;
  description: string;
  visibility: string;
  topics: string[];
  language: string;
  languageColor: string;
  stars: number;
  license: string;
  href: string;
}

export interface DsHomeData {
  _meta: {
    generatedAt: string;
    cycleId: string;
    adapter: string;
    sourceFile: string;
  };
  /** Pass to SignalRadar, SignalGraph, SignalTicker, or iterate for RankRows. */
  signals: DsSignal[];
  /** Co-mention graph edges from ENGINE-008 (rev 4). Empty when no factsByCluster. */
  links: GraphLink[];
  /** Ardur project cards for RepoCard (live GitHub data or curated static fallback). */
  repos: RepoCardData[];
}

// ---------------------------------------------------------------------------
// HTML entity decoder
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtml(text: string): string {
  return text.replace(/&(?:#\d+|#x[\da-f]+|[a-z0-9]+);/gi, (entity) => {
    if (entity in HTML_ENTITIES) return HTML_ENTITIES[entity];
    const dec = entity.match(/^&#(\d+);$/);
    if (dec) return String.fromCharCode(parseInt(dec[1], 10));
    const hex = entity.match(/^&#x([\da-f]+);$/i);
    if (hex) return String.fromCharCode(parseInt(hex[1], 16));
    return entity;
  });
}

// ---------------------------------------------------------------------------
// Project name normalisation
// ---------------------------------------------------------------------------

const PROJECT_NAMES: Record<string, string> = {
  opentofu: 'OpenTofu',
  dapr: 'Dapr',
  helm: 'Helm',
  kubernetes: 'Kubernetes',
  envoy: 'Envoy',
  istio: 'Istio',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  linkerd: 'Linkerd',
  argo: 'Argo',
  flux: 'Flux',
  crossplane: 'Crossplane',
  karpenter: 'Karpenter',
  cilium: 'Cilium',
  containerd: 'containerd',
  opentelemetry: 'OpenTelemetry',
  keycloak: 'Keycloak',
  langchain: 'LangChain',
  langgraph: 'LangGraph',
};

function normProjectName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return PROJECT_NAMES[lower] ?? raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Ref deduplication
// ---------------------------------------------------------------------------

function dedupeRefs(refs: EngineRef[]): EngineRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.title)) return false;
    seen.add(r.title);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Word overlap (for alt-title relevance filtering)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'is',
  'it',
  'its',
  'as',
  'are',
  'was',
  'by',
  'from',
  'that',
  'this',
  'be',
  'has',
  'have',
  'had',
  'not',
  'do',
  'did',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function wordOverlap(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / wa.size;
}

// ---------------------------------------------------------------------------
// Version extraction from a ref title
// ---------------------------------------------------------------------------

const VERSION_RE = /v\d+[\d.]*(?:-rc[\d.]*|-alpha[\d.]*|-beta[\d.]*)?/i;

function extractVersion(title: string): string | null {
  const m = title.match(VERSION_RE);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Deterministic summary generator — 0 AI tokens
// ---------------------------------------------------------------------------

function generateSummary(headline: string, refs: EngineRef[], facts: EngineFact[]): string {
  const h = decodeHtml(headline).trim();
  const unique = dedupeRefs(refs);
  const refTitles = unique.map((r) => decodeHtml(r.title).trim());

  // ── Pattern A: Release notes ────────────────────────────────────────────
  // Trigger: any ref is from "Release notes from <project>" AND headline contains a version tag.
  const releaseRef = unique.find((r) => /^release notes from\s/i.test(r.source));
  const headlineHasVersion = VERSION_RE.test(h);

  if (releaseRef && headlineHasVersion) {
    const project = normProjectName(releaseRef.source.replace(/^release notes from\s+/i, ''));
    // Extract version tags from all unique ref titles
    const versions = refTitles.map(extractVersion).filter(Boolean) as string[];
    const uniqueVersions = [...new Set(versions)];

    if (uniqueVersions.length === 1) {
      return `${project} ${uniqueVersions[0]} patch release.`;
    }
    const [main, ...rest] = uniqueVersions;
    return `${project} ships ${main} alongside ${rest.join(', ')}.`;
  }

  // ── Pattern B: Podcast / talk ────────────────────────────────────────────
  if (/^podcast:/i.test(h)) {
    const clean = h.replace(/^podcast:\s*/i, '').trim();
    return clean.endsWith('.') ? clean : clean + '.';
  }

  // ── Pattern C: Quote / link post ─────────────────────────────────────────
  if (/^quoting\s+/i.test(h)) {
    const who = h.replace(/^quoting\s+/i, '').trim();
    const source = unique[0]?.source ?? 'A practitioner';
    const personTerms = who.toLowerCase().split(/\s+/);

    // Scope to facts that explicitly mention the quoted person to avoid cross-cluster noise
    const relevantFacts = facts.filter((f) =>
      f.entities.some((e) => personTerms.some((p) => e.toLowerCase().includes(p))),
    );
    const factsPool = relevantFacts.length > 0 ? relevantFacts : facts;

    const topicHint = factsPool
      .flatMap((f) => f.entities)
      .filter(
        (e) =>
          e.length > 7 &&
          !/^(this|that|these|those|when|skip|reload|dismiss|public|fork|star|dummies|tags)$/i.test(
            e,
          ) &&
          !personTerms.some((p) => e.toLowerCase().includes(p)),
      )
      .find(Boolean);

    if (topicHint) {
      return `${source} surfaces ${who}'s take on ${topicHint.toLowerCase()}.`;
    }
    return `${source} surfaces a notable quote from ${who}.`;
  }

  // ── Pattern D: Rich headline — has quantifiers/numbers and is concise ────
  // When the headline itself contains the key fact (numbers, ratios, percentages),
  // it IS the summary. No truncation + appending — that would hide the specific fact.
  const hasQuantifier =
    /\d|\b(twice|triple|double|half|percent|billion|million|thousand|×|fold)\b/i.test(h);
  if (hasQuantifier && h.length <= 90) {
    return h.endsWith('.') ? h : h + '.';
  }

  // ── Pattern E: Multi-ref — use first additive alternative title ───────────
  // "First" preserves the engine's relevance ordering (best corroborating source first).
  // Filter out near-duplicates (word overlap > 75% with headline).
  const altTitles = refTitles
    .filter((t) => t !== h)
    .filter((t) => t.length > 15)
    .filter((t) => wordOverlap(h, t) < 0.75);

  if (altTitles.length > 0) {
    const best = altTitles[0];

    // Short headline (≤ 50 chars, like "SpaceX, Anthropic, and OpenAI's hot IPO summer"):
    // the alt title is more descriptive — use it alone.
    if (h.length <= 50) {
      const altTrunc = best.length > 90 ? best.slice(0, 87) + '…' : best;
      return altTrunc.endsWith('.') ? altTrunc : altTrunc + '.';
    }

    // Long headline: show both — truncate headline to ~67 chars at a word boundary,
    // then append best alt as a clause.
    const hTrunc = (() => {
      if (h.length <= 70) return h;
      const cut = h.lastIndexOf(' ', 67);
      return h.slice(0, cut > 40 ? cut : 67) + '…';
    })();
    const altTrunc = best.length > 65 ? best.slice(0, 62) + '…' : best;
    return `${hTrunc}; ${altTrunc}.`;
  }

  // ── Pattern F: Single source / fallback ──────────────────────────────────
  const tidy = h.length > 120 ? h.slice(0, h.lastIndexOf(' ', 117)) + '…' : h;
  return tidy.endsWith('.') ? tidy : tidy + '.';
}

// ---------------------------------------------------------------------------
// Confidence normaliser
// ---------------------------------------------------------------------------

function normaliseConfidence(raw: string): 'High' | 'Medium' | 'Low' {
  switch (raw.toLowerCase()) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    default:
      return 'Low';
  }
}

// ---------------------------------------------------------------------------
// Delta formatter
// ---------------------------------------------------------------------------

function formatDelta(delta: EngineSignal['delta'], currentRank: number): string {
  if (!delta || delta.movement === 'new' || delta.previousRank === null) return 'NEW';
  const diff = delta.previousRank - currentRank;
  if (delta.movement === 'up' && diff > 0) return `+${diff}`;
  if (delta.movement === 'down' && diff < 0) return `${diff}`;
  return '→';
}

// ---------------------------------------------------------------------------
// Repo card data — live from projects.json; static fallback if absent
// ---------------------------------------------------------------------------

const STATIC_REPOS: RepoCardData[] = [
  {
    name: 'ardur-pipeline',
    description:
      'Deterministic signal-intelligence pipeline — RSS aggregation, ranking, top-10 synthesis, and design-system adapter.',
    visibility: 'PUBLIC',
    topics: ['signal-intelligence', 'rss', 'typescript', 'pipeline'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/gnanirahulnutakki/ardur-pipeline',
  },
];

function loadRepos(): RepoCardData[] {
  try {
    const raw = JSON.parse(readFileSync(projectsPath, 'utf8'));
    if (Array.isArray(raw) && raw.length > 0) return raw as RepoCardData[];
  } catch {
    /* projects.json absent — use static fallback */
  }
  return STATIC_REPOS;
}

function loadLinks(): GraphLink[] {
  try {
    const raw = JSON.parse(readFileSync(graphPath, 'utf8'));
    const links = raw.links;
    if (Array.isArray(links)) return links as GraphLink[];
  } catch {
    /* graph.json absent — no links */
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(): void {
  const top10Raw = JSON.parse(readFileSync(top10Path, 'utf8'));
  const rankingRaw = JSON.parse(readFileSync(rankingPath, 'utf8'));

  const global10: EngineSignal[] = top10Raw.data?.global ?? [];
  const factsByCluster: Record<string, EngineFact[]> = rankingRaw.data?.factsByCluster ?? {};

  if (global10.length === 0) {
    throw new Error('No global top-10 signals found in ' + top10Path);
  }

  const signals: DsSignal[] = global10.map((s) => {
    const facts = factsByCluster[s.clusterId] ?? [];
    const unique = dedupeRefs(s.references);
    // Rev 4: prefer engine-emitted summary over adapter-generated fallback
    const summary = s.summary ?? generateSummary(s.headline, s.references, facts);

    return {
      // Rev 4: use stable signalId from engine; fall back to cycle-scoped "s1"..."s10"
      id: s.signalId ?? `s${s.rank}`,
      signalId: s.signalId,
      rank: s.rank,
      title: decodeHtml(s.headline),
      summary,
      topic: s.topic,
      topicLabel: s.topicLabel,
      sources: unique.length,
      score: Math.round(s.score.total * 1000) / 1000,
      confidence: normaliseConfidence(s.confidence),
      href: unique[0]?.url ?? '#',
      kicker: s.topicLabel,
      meta: `${unique.length} source${unique.length !== 1 ? 's' : ''}`,
      delta: formatDelta(s.delta, s.rank),
    };
  });

  const cycleId: string = top10Raw.cycle?.id ?? top10Raw.generatedAt ?? 'unknown';

  // Rev 4: load real graph links + projects (fallback to static when absent)
  const links = loadLinks();
  const repos = loadRepos();

  const output: DsHomeData = {
    _meta: {
      generatedAt: new Date().toISOString(),
      cycleId,
      adapter: 'scripts/ds-adapter.ts',
      sourceFile: resolve(top10Path),
    },
    signals,
    links,
    repos,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  // Print summary to stdout
  const topics = [...new Set(signals.map((s) => s.topic))].join(', ');
  process.stdout.write(
    [
      '',
      `ds-home.json → ${resolve(outPath)}`,
      `  cycle   : ${cycleId}`,
      `  signals : ${signals.length} (topics: ${topics})`,
      '',
      'Summaries:',
      ...signals.map(
        (s) => `  #${String(s.rank).padStart(2)} [${s.topic.padEnd(10)}] ${s.summary}`,
      ),
      '',
    ].join('\n'),
  );
}

run();
