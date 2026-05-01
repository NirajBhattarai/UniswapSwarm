import { COINGECKO_API_BASE_URL, getConfig, logger } from "@swarm/shared";
import type { Impit } from "impit";

import { NARRATIVE_KEYWORDS } from "../core/constants";
import type { NarrativeSignal, NarrativeType } from "../core/types";
import { normalizeSymbol } from "../utils";
import { fetchTrendingTokens } from "./trendingPairs";

export async function fetchNarrativeSignal(
  browser: Impit,
  prefetchedTrendingTokens?: string[],
): Promise<NarrativeSignal> {
  const [fearGreed, redditTitles, newsTitles] = await Promise.all([
    fetchFearGreed(browser),
    fetchRedditPosts(browser),
    fetchCoinTelegraphRSS(browser),
  ]);
  const trending =
    prefetchedTrendingTokens && prefetchedTrendingTokens.length > 0
      ? prefetchedTrendingTokens
      : await fetchCoinGeckoTrending(browser);

  const allTitles = [...redditTitles, ...newsTitles];
  logger.info(
    `[Researcher][narrative] scoring ${allTitles.length} headlines (reddit:${redditTitles.length} ct:${newsTitles.length})`,
  );
  const scores = scoreNarratives(allTitles);
  const winnerNarrative = selectWinningNarrative(scores, fearGreed.score);
  const finalHeadlines = pickNarrativeHeadlines(allTitles, winnerNarrative);

  return {
    narrative: winnerNarrative,
    score: scores[winnerNarrative] ?? 0,
    topHeadlines: finalHeadlines,
    trendingTokens: trending,
    fearGreedValue: fearGreed.score,
    fearGreedLabel: fearGreed.label,
  };
}

/**
 * Converts a keyword into a regex that matches whole words / phrases.
 * e.g. "ai" → /\bai\b/i so it won't match inside "stain", "rain" etc.
 */
function kwToRegex(kw: string): RegExp {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function scoreNarratives(headlines: string[]): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const [name, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    if (name === "neutral") continue;
    const regexes = keywords.map(kwToRegex);
    const matchedHits: string[] = [];
    scores[name] = headlines.reduce((acc, title) => {
      const matched = keywords.filter((_, i) => regexes[i]!.test(title));
      if (matched.length)
        matchedHits.push(`"${matched.join(",")}" in: ${title.slice(0, 80)}`);
      return acc + matched.length;
    }, 0);
    if (scores[name]! > 0)
      logger.info(
        `[Researcher][narrative] ${name}=${scores[name]}: ${matchedHits.join(" | ")}`,
      );
  }
  logger.info(`[Researcher][narrative] scores: ${JSON.stringify(scores)}`);

  return scores;
}

function selectWinningNarrative(
  scores: Record<string, number>,
  fearGreedScore: number,
): NarrativeType {
  if (fearGreedScore < 25) return "safe_haven";

  const [topName, topScore] = Object.entries(scores).sort(
    ([, a], [, b]) => b - a,
  )[0] ?? ["neutral", 0];
  if (topScore > 0) return topName as NarrativeType;
  return "neutral";
}

function pickNarrativeHeadlines(
  allTitles: string[],
  narrative: NarrativeType,
): string[] {
  const matchingKws = NARRATIVE_KEYWORDS[narrative] ?? [];
  const topHeadlines = allTitles
    .filter((t) => matchingKws.some((kw) => t.toLowerCase().includes(kw)))
    .slice(0, 5);

  return topHeadlines.length > 0 ? topHeadlines : allTitles.slice(0, 5);
}

async function fetchFearGreed(
  browser: Impit,
): Promise<{ score: number; label: string }> {
  try {
    const res = await browser.fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ value: string; value_classification: string }>;
    };
    const item = json.data?.[0];
    return item
      ? { score: Number(item.value), label: item.value_classification }
      : { score: 50, label: "Neutral" };
  } catch (err) {
    logger.warn(`[Researcher] fetchFearGreed failed: ${err}`);
    return { score: 50, label: "Neutral" };
  }
}

async function fetchCoinGeckoTrending(browser: Impit): Promise<string[]> {
  try {
    const prefetched = await fetchTrendingTokens();
    if (prefetched.trendingSymbols.length > 0) {
      return prefetched.trendingSymbols;
    }
    const url = `${COINGECKO_API_BASE_URL}/search/trending`;
    const { COINGECKO_API_KEY } = getConfig();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
    const res = await browser.fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      coins?: Array<{ item: { symbol: string } }>;
    };
    return (json.coins ?? [])
      .slice(0, 7)
      .map((c) => normalizeSymbol(c.item.symbol));
  } catch (err) {
    logger.warn(`[Researcher] fetchCoinGeckoTrending failed: ${err}`);
    return [];
  }
}

async function fetchRedditPosts(browser: Impit): Promise<string[]> {
  try {
    const res = await browser.fetch(
      "https://www.reddit.com/r/CryptoCurrency/hot.rss?limit=25",
      { headers: { Accept: "application/rss+xml, application/xml" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title>([^<]{10,300})<\/title>/g)]
      .map((m) =>
        (m[1] ?? "")
          .trim()
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">"),
      )
      .filter(Boolean)
      .slice(1, 21);
    return titles;
  } catch (err) {
    logger.warn(`[Researcher] fetchRedditPosts failed: ${err}`);
    return [];
  }
}

async function fetchCoinTelegraphRSS(browser: Impit): Promise<string[]> {
  try {
    const res = await browser.fetch("https://cointelegraph.com/rss", {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const cdataRe = /<title><!\[CDATA\[(.+?)\]\]><\/title>/gs;
    const cdataMatches = [...xml.matchAll(cdataRe)];
    if (cdataMatches.length > 0) {
      return cdataMatches
        .map((m) => (m[1] ?? "").trim())
        .filter(Boolean)
        .slice(1, 21);
    }

    const plainRe = /<title>([^<]{3,200})<\/title>/g;
    const plain = [...xml.matchAll(plainRe)];
    return plain
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean)
      .slice(1, 21);
  } catch (err) {
    logger.warn(`[Researcher] fetchCoinTelegraphRSS failed: ${err}`);
    return [];
  }
}
