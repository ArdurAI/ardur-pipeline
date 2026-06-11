/**
 * Ardur content pipeline — shared data contracts.
 *
 * Schema version: ardur-content-pipeline/v1
 *
 * This file is the SINGLE SOURCE OF TRUTH for the artifacts that flow between
 * the four engines:
 *
 *   ardur-news-aggregator  ->  ardur-ranking-engine  ->  ardur-top10-engine  ->  ardur-article-synthesizer
 *
 * It is intentionally identical in every repo. Treat it as a vendored contract:
 * change it in lockstep across all four repos, and bump SCHEMA_VERSION on any
 * breaking change. See ARCHITECTURE.md for the end-to-end wiring and the
 * 6-hour refresh loop.
 *
 * Design rules encoded here:
 *  - Every artifact is a versioned envelope tied to a single 6-hour cycle.
 *  - No PII anywhere: no user/session/device ids, IPs, emails, cookies, UTM,
 *    or referrers. Interaction metrics are aggregate-only.
 *  - Copyright-safe: items carry metadata-derived hints and links, never
 *    reproduced article bodies.
 */

export const SCHEMA_VERSION = 'ardur-content-pipeline/v1' as const;

/** Curated source trust tiers (mirrors news-sources.mjs on ardur.ai/main). */
export type SourceTier =
  | 'primary' // first-party vendor/standards body (openai.com, kubernetes.io, nist.gov)
  | 'paper' // research preprints (arxiv.org)
  | 'news' // general/financial press (reuters.com, bloomberg.com)
  | 'technical-news' // practitioner press (infoq.com, thenewstack.io)
  | 'security-news'; // security press (thehackernews.com)

export type Confidence = 'high' | 'medium' | 'low';

export type SourceQuality =
  | 'corroborated' // >= 2 distinct sources, >= 1 trusted
  | 'multi-source' // >= 2 distinct sources
  | 'single trusted source'
  | 'single source';

export type Verification = 'multi-source' | 'single-source';

export type PipelineStage = 'aggregation' | 'ranking' | 'top10' | 'articles';

/** Provenance for any AI-assisted field. Deterministic fallback always populated. */
export interface ProviderMeta {
  provider: 'deterministic' | 'ollama' | 'openai';
  model: string;
  status: 'generated' | 'fallback';
  reason?: string;
  generatedAt: string; // ISO 8601 UTC
}

/** The 6-hour batch window an artifact belongs to. */
export interface CycleMeta {
  id: string; // stable id for the cycle, e.g. "2026-06-11T00:00Z"
  windowStart: string; // ISO 8601 UTC, inclusive
  windowEnd: string; // ISO 8601 UTC, exclusive (windowStart + 6h)
}

export interface TopicMeta {
  id: string;
  label: string;
  description: string;
}

/**
 * Versioned envelope wrapping every inter-engine artifact. `data` is the
 * stage-specific payload (AggregationData | RankingData | Top10Data | ArticleData).
 */
export interface ArtifactEnvelope<TData> {
  schemaVersion: typeof SCHEMA_VERSION;
  artifact: PipelineStage;
  runId: string; // unique per stage execution
  upstreamRunId: string | null; // producing stage's runId (null for aggregation)
  generatedAt: string; // ISO 8601 UTC
  cycle: CycleMeta;
  topics: TopicMeta[];
  provider?: ProviderMeta; // present where AI is involved
  warnings: string[]; // non-fatal issues (source timeouts, budget exhaustion, ...)
  data: TData;
}

// ---------------------------------------------------------------------------
// Stage 1 — Aggregation (ardur-news-aggregator)
// ---------------------------------------------------------------------------

/** Aggregate-only interaction signals. NEVER carries per-user data. */
export interface InteractionMetrics {
  feedRank: number | null; // 0-based position in the source feed it came from
  shares: number | null;
  comments: number | null;
  reactions: number | null;
  crossSourceMentions: number; // how many distinct sources mention the cluster
  velocity: number | null; // mentions per hour across sources within the window
  capturedAt: string; // ISO 8601 UTC
  provenance: string; // human-readable origin of the metric (e.g. "rss-position")
}

export interface AggregatedItem {
  id: string;
  topic: string;
  topicLabel: string;
  title: string;
  source: string; // display name (e.g. "Reuters")
  sourceDomain: string; // canonical host (e.g. "reuters.com")
  sourceUrl: string; // normalized publisher root, may be ""
  url: string; // normalized public article URL, no PII, no fragment
  tier: SourceTier;
  publishedAt: string; // ISO 8601 UTC
  summaryHint: string; // metadata/feed-derived hint — NOT the article body
  interaction: InteractionMetrics;
  clusterId: string; // cluster this item was assigned to
  fingerprint: string; // dedup key (normalized title + canonical url)
}

export interface Cluster {
  clusterId: string;
  topic: string;
  topicLabel: string;
  headline: string; // representative member title
  memberIds: string[]; // AggregatedItem.id values
  sourceCount: number; // distinct sources
  distinctDomains: number; // distinct source domains
  tierHistogram: Partial<Record<SourceTier, number>>;
  earliestPublishedAt: string;
  latestPublishedAt: string;
}

export interface SourceCoverage {
  sourcesConfigured: number; // sources targeted for the topic (target: >= 20)
  sourcesQueried: number;
  sourcesResponded: number;
  distinctDomains: number;
  degraded: boolean; // true if below the diversity floor
}

export interface AggregationData {
  itemsByTopic: Record<string, AggregatedItem[]>;
  clustersByTopic: Record<string, Cluster[]>;
  coverageByTopic: Record<string, SourceCoverage>;
}

export type AggregationArtifact = ArtifactEnvelope<AggregationData>;

// ---------------------------------------------------------------------------
// Stage 2 — Ranking (ardur-ranking-engine)
// ---------------------------------------------------------------------------

/** Per-signal contribution to a cluster's score. */
export interface ScoreBreakdown {
  interaction: number;
  credibility: number;
  recency: number;
  diversity: number;
  corroboration: number;
  total: number;
  weights: Record<string, number>; // weights actually applied
}

export interface RankedCluster {
  clusterId: string;
  topic: string;
  topicLabel: string;
  headline: string;
  rank: number; // 1-based within topic
  score: ScoreBreakdown;
  sourceQuality: SourceQuality;
  confidence: Confidence;
  verification: Verification;
  sourceCount: number;
  distinctDomains: number;
  tierHistogram: Partial<Record<SourceTier, number>>;
  memberIds: string[];
  earliestPublishedAt: string;
  latestPublishedAt: string;
  auditId: string; // -> AuditEntry.auditId
}

/** Fully reproducible record of how one cluster's score was computed. */
export interface AuditEntry {
  auditId: string;
  clusterId: string;
  topic: string;
  inputs: Record<string, number>; // raw signal values before weighting
  weights: Record<string, number>;
  computed: ScoreBreakdown;
  rationale: string; // short human-readable explanation
  weightProfile: string; // named, versioned weight profile id
  rankedAt: string;
}

export interface RankingData {
  rankedByTopic: Record<string, RankedCluster[]>;
  audit: AuditEntry[];
  weightProfile: string; // e.g. "balanced@v1"
}

export type RankingArtifact = ArtifactEnvelope<RankingData>;

// ---------------------------------------------------------------------------
// Stage 3 — Top-10 (ardur-top10-engine)
// ---------------------------------------------------------------------------

/** Copyright-safe reference: link + attribution metadata, never article body. */
export interface SourceRef {
  source: string;
  sourceDomain: string;
  tier: SourceTier;
  url: string;
  title: string;
  publishedAt: string;
}

export interface Top10Entry {
  rank: number; // 1..10
  clusterId: string;
  topic: string;
  topicLabel: string;
  headline: string;
  score: ScoreBreakdown;
  sourceQuality: SourceQuality;
  confidence: Confidence;
  references: SourceRef[]; // deduped, capped (default 5)
  delta: {
    previousRank: number | null;
    movement: 'new' | 'up' | 'down' | 'same';
  };
  carriedOver: boolean; // present in the previous cycle's Top-10
}

export interface StabilityReport {
  carriedOver: number;
  fresh: number; // newly entered this cycle
  churnRate: number; // 0..1 fraction replaced vs previous cycle
}

export interface Top10Data {
  nextRefreshAt: string; // generatedAt + 6h
  topicsCovered: string[];
  top10ByTopic: Record<string, Top10Entry[]>;
  global: Top10Entry[]; // the "all" Top-10
  stability: StabilityReport;
}

export type Top10Artifact = ArtifactEnvelope<Top10Data>;

// ---------------------------------------------------------------------------
// Stage 4 — Article synthesis (ardur-article-synthesizer)
// ---------------------------------------------------------------------------

/** In-app render block. The app renders these with no navigation away. */
export interface ArticleBlock {
  type: 'paragraph' | 'heading' | 'list' | 'quote' | 'callout';
  text?: string; // for paragraph | heading | quote | callout
  items?: string[]; // for list
  /** Quotes must be < 25 words and carry attribution. */
  attribution?: { source: string; url: string };
}

export interface ArticleReference {
  source: string;
  sourceDomain: string;
  tier: SourceTier;
  url: string;
  title: string;
  publishedAt: string;
}

export interface SynthesizedArticle {
  id: string;
  rank: number; // mirrors the Top-10 rank it was synthesized from
  topic: string;
  topicLabel: string;
  headline: string; // original
  dek: string; // original standfirst / subtitle
  body: ArticleBlock[]; // original prose, in-app render model
  keyPoints: string[];
  whyItMatters: string;
  readerAction: string;
  tags: string[];
  confidence: Confidence;
  sourceQuality: SourceQuality;
  references: ArticleReference[]; // canonical links to every source synthesized
  provenance: {
    clusterId: string;
    sourceCount: number;
    distinctDomains: number;
    upstreamRunId: string;
  };
  ai: ProviderMeta;
  legalNote: string;
  wordCount: number;
  readingTimeMinutes: number;
  generatedAt: string;
}

export interface CopyrightPolicy {
  originalTextOnly: true;
  maxQuoteWords: number; // default 25
  reproduceArticleBody: false;
  requireAttribution: true;
  requireCanonicalLinks: true;
}

export interface ArticleData {
  articles: SynthesizedArticle[]; // one per Top-10 entry
  copyrightPolicy: CopyrightPolicy;
}

export type ArticleArtifact = ArtifactEnvelope<ArticleData>;

// ---------------------------------------------------------------------------
// Cross-stage helpers
// ---------------------------------------------------------------------------

/** Forbidden substrings in any metric key — privacy guard reused by every engine. */
export const FORBIDDEN_METRIC_KEY_FRAGMENTS: readonly string[] = [
  'userid', 'visitorid', 'deviceid', 'accountid', 'session', 'cookie',
  'token', 'secret', 'email', 'phone', 'ipaddress', 'useragent',
  'fingerprint', 'referrer', 'referer', 'utm', 'campaign', 'rawevent',
];

/** Canonical 6-hour cycle length in milliseconds. */
export const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
