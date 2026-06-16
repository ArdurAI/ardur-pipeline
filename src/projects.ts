/**
 * projects.ts — deterministic GitHub API fetch for RepoCard data (GAP-6).
 *
 * Fetches live star counts, description, and language from the GitHub REST API
 * for a curated list of Ardur repos. Falls back to static data on any error
 * (rate limit, network, missing token). The output shape matches RepoCardProps
 * in the design-system.
 *
 * Called from the pipeline publish step; output written to latest/projects.json.
 * This is a best-effort enrichment — a failed fetch never blocks the cycle.
 */

import type { Logger } from './log.ts';

export interface ProjectCard {
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

/** GitHub linguist language colors (deterministic, no network). */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Shell: '#89e051',
};

/** Static curated fallback for when the API is unavailable. */
const STATIC_PROJECTS: ProjectCard[] = [
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
    href: 'https://github.com/ArdurAI/ardur-pipeline',
  },
  {
    name: 'ardur-contracts',
    description:
      'Shared wire contract for the Ardur AI content pipeline — Zod schemas, TypeScript types, and Tier-1/2 validation.',
    visibility: 'PUBLIC',
    topics: ['contracts', 'zod', 'typescript', 'schema'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/ArdurAI/ardur-contracts',
  },
  {
    name: 'ardur-article-synthesizer',
    description:
      'Copyright-safe article synthesis from Top-10 topics and clustered sources — stage 4 of the Ardur pipeline.',
    visibility: 'PUBLIC',
    topics: ['synthesis', 'copyright-safe', 'provenance', 'typescript'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/ArdurAI/ardur-article-synthesizer',
  },
  {
    name: 'ardur-top10-engine',
    description:
      'Top-10 signal selector with co-mention graph (ENGINE-008) — deterministic ranking from aggregated clusters.',
    visibility: 'PUBLIC',
    topics: ['ranking', 'graph', 'signal-intelligence', 'typescript'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/ArdurAI/ardur-top10-engine',
  },
  {
    name: 'ardur-ranking-engine',
    description:
      'Multi-signal scoring engine — corroboration, credibility, recency, and diversity for cluster ranking.',
    visibility: 'PUBLIC',
    topics: ['scoring', 'ranking', 'signal-intelligence', 'typescript'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/ArdurAI/ardur-ranking-engine',
  },
  {
    name: 'ardur-news-aggregator',
    description:
      'RSS and news aggregator — multi-source feed ingest, deduplication, and cluster formation.',
    visibility: 'PUBLIC',
    topics: ['rss', 'aggregation', 'deduplication', 'typescript'],
    language: 'TypeScript',
    languageColor: '#3178c6',
    stars: 0,
    license: 'MIT',
    href: 'https://github.com/ArdurAI/ardur-news-aggregator',
  },
];

const ARDUR_REPOS = [
  { owner: 'ArdurAI', repo: 'ardur-pipeline' },
  { owner: 'ArdurAI', repo: 'ardur-contracts' },
  { owner: 'ArdurAI', repo: 'ardur-article-synthesizer' },
  { owner: 'ArdurAI', repo: 'ardur-top10-engine' },
  { owner: 'ArdurAI', repo: 'ardur-ranking-engine' },
  { owner: 'ArdurAI', repo: 'ardur-news-aggregator' },
];

interface GhRepoResponse {
  name?: string;
  description?: string | null;
  private?: boolean;
  topics?: string[];
  language?: string | null;
  stargazers_count?: number;
  license?: { spdx_id?: string } | null;
  html_url?: string;
}

async function fetchRepo(
  owner: string,
  repo: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<GhRepoResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return (await resp.json()) as GhRepoResponse;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch live project data from GitHub API.
 * Returns the static fallback on any fetch failure (never throws).
 */
export async function fetchProjects(opts: {
  githubToken?: string;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<ProjectCard[]> {
  const { githubToken, timeoutMs = 8000, logger } = opts;

  const results: ProjectCard[] = [];

  for (const { owner, repo } of ARDUR_REPOS) {
    const data = await fetchRepo(owner, repo, githubToken, timeoutMs);
    if (!data) {
      logger?.warn('projects: GitHub API unavailable or rate-limited', { owner, repo });
      // Return static fallback for this repo if available
      const fallback = STATIC_PROJECTS.find((p) => p.name === repo);
      if (fallback) results.push(fallback);
      continue;
    }

    const language = data.language ?? 'TypeScript';
    results.push({
      name: data.name ?? repo,
      description: data.description ?? '',
      visibility: data.private ? 'PRIVATE' : 'PUBLIC',
      topics: data.topics ?? [],
      language,
      languageColor: LANGUAGE_COLORS[language] ?? '#586069',
      stars: data.stargazers_count ?? 0,
      license: data.license?.spdx_id ?? 'MIT',
      href: data.html_url ?? `https://github.com/${owner}/${repo}`,
    });
  }

  // Fill any missing repos from the static fallback
  for (const fallback of STATIC_PROJECTS) {
    if (!results.some((r) => r.name === fallback.name)) {
      results.push(fallback);
    }
  }

  return results.length > 0 ? results : STATIC_PROJECTS;
}
