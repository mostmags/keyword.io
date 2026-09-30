/**
 * Multi-Signal Deterministic Relevance Ranking Engine for Keyword Finder.
 * Ensures that the most relevant keywords to the user's exact search query
 * appear at the top, without search volume/suggest position overpowering relevance.
 */

import { cleanText, tokenize } from './normalizer.js';
import { extractIntent } from './intentExtractor.js';

// Common function/stop words that do not establish core topic alone
const FUNCTION_WORDS = new Set([
  'how', 'to', 'do', 'i', 'can', 'you', 'is', 'it', 'a', 'an', 'the', 
  'in', 'on', 'at', 'by', 'for', 'with', 'from', 'of', 'and', 'or'
]);

// Common generic action verbs that require a substantive object/platform to define a topic
const GENERIC_ACTIONS = new Set([
  'add', 'link', 'connect', 'remove', 'delete', 'send', 'transfer', 'buy', 'sell',
  'turn', 'enable', 'disable', 'login', 'logout', 'change', 'update', 'fix', 'repair',
  'make', 'create', 'set', 'setup', 'use', 'get', 'put', 'find', 'check', 'view'
]);

/**
 * Check if candidate tokens match query tokens with prefix support for typing (e.g. 'e' -> 'eth').
 */
function computeTokenMatches(queryTokens, candidateTokens) {
  let exactMatches = 0;
  let prefixMatches = 0;
  let contentMatches = 0;
  const matchedCandidateIndices = new Set();
  const matchedQueryIndices = new Set();

  // Distinguish between full content tokens (>= 2 chars) and single-letter transient typing tokens
  const queryFullContentTokens = queryTokens.filter(t => !FUNCTION_WORDS.has(t) && t.length >= 2);
  const queryContentTokens = queryTokens.filter(t => !FUNCTION_WORDS.has(t));

  queryTokens.forEach((qTok, qIdx) => {
    // 1. Exact match
    candidateTokens.forEach((cTok, cIdx) => {
      if (!matchedCandidateIndices.has(cIdx) && !matchedQueryIndices.has(qIdx)) {
        if (qTok === cTok) {
          exactMatches++;
          if (!FUNCTION_WORDS.has(qTok)) contentMatches += 1.0;
          matchedCandidateIndices.add(cIdx);
          matchedQueryIndices.add(qIdx);
        }
      }
    });

    // 2. Prefix match (e.g. 'eth' matches 'ethereum')
    if (!matchedQueryIndices.has(qIdx)) {
      candidateTokens.forEach((cTok, cIdx) => {
        if (!matchedCandidateIndices.has(cIdx) && !matchedQueryIndices.has(qIdx)) {
          // Single-character tokens are mid-typing fragments (e.g. 'b' in
          // "how to activate b cash app"). They may ONLY match the candidate
          // token at the same position — the word being typed at the cursor —
          // so trailing words like 'before' cannot falsely absorb the 'b'.
          if (qTok.length === 1) {
            if (cIdx !== qIdx) return;
          }
          if (cTok.startsWith(qTok) && (qTok.length >= 1 || cTok.length > qTok.length)) {
            prefixMatches++;
            if (!FUNCTION_WORDS.has(qTok)) contentMatches += 0.85;
            matchedCandidateIndices.add(cIdx);
            matchedQueryIndices.add(qIdx);
          }
        }
      });
    }
  });

  return {
    exactMatches,
    prefixMatches,
    contentMatches,
    queryContentCount: queryContentTokens.length,
    queryFullContentCount: queryFullContentTokens.length,
    matchedCount: exactMatches + prefixMatches,
    matchedOrder: Array.from(matchedCandidateIndices).sort((a, b) => a - b),
    matchedQueryIndices
  };
}

/**
 * Calculate longest common subsequence length for order score.
 */
function computeOrderScore(matchedIndices) {
  if (matchedIndices.length <= 1) return 1.0;
  let inOrderCount = 1;
  for (let i = 1; i < matchedIndices.length; i++) {
    if (matchedIndices[i] > matchedIndices[i - 1]) {
      inOrderCount++;
    }
  }
  return inOrderCount / matchedIndices.length;
}

/**
 * Check how many tokens match at the start of both phrases
 */
function countCommonPrefixTokens(qTokens, cTokens) {
  let count = 0;
  const minLen = Math.min(qTokens.length, cTokens.length);
  for (let i = 0; i < minLen; i++) {
    if (qTokens[i] === cTokens[i]) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Check if a keyword appears complete vs trailing preposition
 */function computeCompletenessScore(keyword) {
  const cleaned = cleanText(keyword);
  const trailingPrepositions = ['to', 'for', 'with', 'from', 'in', 'on', 'at', 'by', 'of', 'and', 'or'];
  const words = cleaned.split(' ');
  const lastWord = words[words.length - 1];

  if (trailingPrepositions.includes(lastWord)) {
    return 0.5; // Penalize trailing preposition
  }
  if (words.length < 3) {
    return 0.7; // Very short phrase
  }
  return 1.0;
}

/**
 * Calculate composite relevance score between query and a keyword candidate.
 * Returns a score between 0 and 100.
 */
export function scoreKeywordRelevance(query = '', candidate = '', rawRankIndex = 0) {
  const cleanQuery = cleanText(query);
  const cleanCandidate = cleanText(candidate);

  if (!cleanQuery || !cleanCandidate) return 0;
  if (cleanCandidate === cleanQuery) return 100;

  const queryTokens = tokenize(cleanQuery, false);
  const candidateTokens = tokenize(cleanCandidate, false);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  // Substantive noun/entity guard:
  // If query contains substantive nouns (e.g. 'botim', 'robinhood', 'phonepe'),
  // candidate MUST match at least one substantive noun (or prefix), otherwise it is completely unrelated noise.
  const querySubstantiveTokens = queryTokens.filter(t => !FUNCTION_WORDS.has(t) && !GENERIC_ACTIONS.has(t) && t.length >= 2);
  if (querySubstantiveTokens.length > 0) {
    const matchesSubstantive = querySubstantiveTokens.some(st => 
      candidateTokens.some(ct => ct === st || ct.startsWith(st) || st.startsWith(ct))
    );
    if (!matchesSubstantive) {
      return 5; // Heavily penalize noise (e.g. CapCut when searching Botim)
    }
  }

  const tokenMatchResult = computeTokenMatches(queryTokens, candidateTokens);

  // Mid-typing fragment guard: single-character content tokens (e.g. the 'b'
  // in "how to activate b cash app") are the word the user is still typing.
  // Candidates that fail to match it at its position are partial matches only
  // and must not be rewarded as if the query were the cleaned phrase.
  let unmatchedSingles = 0;
  queryTokens.forEach((t, i) => {
    if (t.length === 1 && !FUNCTION_WORDS.has(t) && !tokenMatchResult.matchedQueryIndices.has(i)) {
      unmatchedSingles++;
    }
  });

  // CRITICAL GUARD: If query has content words (e.g. 'send', 'money', 'robinhood'),
  // and candidate matches ZERO of them, it is completely irrelevant noise!
  if (tokenMatchResult.queryContentCount > 0 && tokenMatchResult.contentMatches === 0) {
    return 5; // Heavily penalize noise like "how to cook a steak" when searching "how to send money on robinhood"
  }

  // 1. Exact Phrase & Common Prefix Match (0 to 25 points)
  let exactPhraseScore = 0;
  const cleanQueryNoSingles = cleanQuery.replace(/\b([b-hj-z0-9])\b\s*/gi, '').replace(/\s+/g, ' ').trim();

  if (cleanCandidate.startsWith(cleanQuery)) {
    exactPhraseScore = 25;
  } else if (cleanQueryNoSingles && cleanCandidate.startsWith(cleanQueryNoSingles)) {
    exactPhraseScore = 25;
  } else if (cleanCandidate.includes(cleanQuery) || (cleanQueryNoSingles && cleanCandidate.includes(cleanQueryNoSingles))) {
    exactPhraseScore = 20;
  } else {
    // Check common starting phrase tokens (e.g. "how to send money...")
    const prefixCount = countCommonPrefixTokens(queryTokens, candidateTokens);
    if (prefixCount >= 3) {
      exactPhraseScore = Math.min(22, 10 + prefixCount * 3);
    } else if (prefixCount >= 2) {
      exactPhraseScore = 6;
    }
  }

  // 2. Token Overlap Score (0 to 35 points)
  // When measuring content token overlap, use queryFullContentCount as base denominator
  // so dropped dangling single characters (typos/prefixes) don't penalize authentic suggestions
  const contentDenominator = tokenMatchResult.queryFullContentCount > 0
    ? tokenMatchResult.queryFullContentCount
    : (tokenMatchResult.queryContentCount > 0 ? tokenMatchResult.queryContentCount : 1);
  const contentOverlapRatio = Math.min(1.0, tokenMatchResult.contentMatches / contentDenominator);
  const totalTokenRatio = (tokenMatchResult.exactMatches * 1.0 + tokenMatchResult.prefixMatches * 0.85) / queryTokens.length;
  
  const compositeOverlap = contentOverlapRatio * 0.75 + totalTokenRatio * 0.25;
  const tokenOverlapScore = Math.min(35, compositeOverlap * 35);

  // 3. Word Order Score (0 to 15 points)
  const orderRatio = computeOrderScore(tokenMatchResult.matchedOrder);
  const wordOrderScore = orderRatio * 15 * compositeOverlap;

  // 4. Intent & Action Similarity (0 to 15 points)
  const queryIntent = extractIntent(cleanQuery);
  const candidateIntent = extractIntent(cleanCandidate);
  let intentScore = 0;

  // Action match
  if (queryIntent.action && candidateIntent.action) {
    if (queryIntent.action === candidateIntent.action) {
      intentScore += 8;
    } else if (queryIntent.actionGroup === candidateIntent.actionGroup) {
      intentScore += 6;
    } else {
      // Different/opposing action
      intentScore -= 6;
    }
  } else if (!queryIntent.action) {
    intentScore += 4;
  }

  // Platform match
  if (queryIntent.platform) {
    if (candidateIntent.platform === queryIntent.platform) {
      intentScore += 5;
    } else {
      intentScore -= 10; // query specified platform, candidate didn't have it
    }
  }

  // Intent type (tutorial, inquiry, etc.)
  if (queryIntent.intent === candidateIntent.intent) {
    intentScore += 2;
  }
  const boundedIntentScore = Math.max(0, Math.min(15, intentScore));

  // 5. Completeness & Long-tail Extension Score (0 to 5 points)
  let completenessScore = computeCompletenessScore(cleanCandidate) * 3;
  // If candidate contains all query full content tokens and extends it with specific details, reward it
  if (tokenMatchResult.queryFullContentCount > 0 && tokenMatchResult.contentMatches >= tokenMatchResult.queryFullContentCount && candidateTokens.length > queryTokens.length) {
    completenessScore += 2; // Long-tail extension bonus
  }

  // 6. Popularity / Suggest Rank Score (0 to 5 points)
  const popularityScore = Math.max(0, 5 - rawRankIndex * 0.15);

  // Composite Total (capped at 100)
  let totalScore = exactPhraseScore + tokenOverlapScore + wordOrderScore + boundedIntentScore + completenessScore + popularityScore;

  // Mid-typing fragment penalty: candidates that ignore the partially-typed
  // word (e.g. "…card before it arrives" for query "…b cash app") are only
  // partial matches and must rank BELOW candidates that complete the fragment
  // (e.g. "…bitcoin…", "…borrow…").
  if (unmatchedSingles > 0) {
    totalScore -= unmatchedSingles * 15;
  }

  return Math.min(100, Math.max(0, Math.round(totalScore * 10) / 10));
}

/**
 * Rank an array of keyword candidates against a user search query.
 * Produces a stable, deterministic sort without penalizing long-tail length.
 * @param {string} query - The user search query
 * @param {Array<string>} candidates - List of candidate keywords
 * @returns {Array<{ keyword: string, relevanceScore: number }>}
 */
export function rankKeywords(query = '', candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!query || !query.trim()) {
    return candidates.map((kw, idx) => ({
      keyword: kw,
      relevanceScore: Math.max(0, 100 - idx)
    }));
  }

  // Score each candidate
  const scored = candidates.map((kw, originalIdx) => {
    const score = scoreKeywordRelevance(query, kw, originalIdx);
    return {
      keyword: kw,
      relevanceScore: score,
      originalIdx
    };
  });

  // Sort deterministically: highest relevance first, then YouTube suggest popularity (originalIdx)
  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    if (a.originalIdx !== b.originalIdx) {
      return a.originalIdx - b.originalIdx;
    }
    return a.keyword.localeCompare(b.keyword);
  });

  return scored.map(({ keyword, relevanceScore }) => ({ keyword, relevanceScore }));
}
