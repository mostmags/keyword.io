/**
 * Preprocessed Channel Indexer for Keyword Finder.
 * Extracts and indexes video metadata (actions, objects, platforms, canonical keys)
 * so lookups against 8,000+ videos take < 1ms without repeated regex operations.
 */

import { cleanText, canonicalKey, topicKey, tokenize } from './normalizer.js';
import { extractIntent } from './intentExtractor.js';

/**
 * Builds an inverted index and pre-parsed metadata list for a channel's videos.
 */
export function buildChannelIndex(videos = []) {
  if (!Array.isArray(videos) || videos.length === 0) {
    return {
      totalVideos: 0,
      indexedVideos: [],
      exactCanonicalMap: new Map(),
      tokenIndex: new Map(),
      actionIndex: new Map(),
      platformIndex: new Map()
    };
  }

  const indexedVideos = [];
  const exactCanonicalMap = new Map();
  const tokenIndex = new Map();
  const actionIndex = new Map();
  const platformIndex = new Map();

  videos.forEach((v, index) => {
    const rawTitle = v.title || '';
    const clean = cleanText(rawTitle);
    const canonical = canonicalKey(rawTitle);
    const topic = topicKey(rawTitle);
    const tokens = tokenize(rawTitle, true);
    const intent = extractIntent(rawTitle);

    const item = {
      index,
      id: v.id,
      rawTitle,
      cleanTitle: clean,
      canonical,
      topicKey: topic,
      tokens,
      platform: intent.platform,
      action: intent.action,
      actionGroup: intent.actionGroup,
      objects: intent.objects,
      intentCategory: intent.intent
    };

    indexedVideos.push(item);

    // Exact canonical mapping
    if (!exactCanonicalMap.has(canonical)) {
      exactCanonicalMap.set(canonical, index);
    }

    // Index tokens
    for (const tok of tokens) {
      if (!tokenIndex.has(tok)) {
        tokenIndex.set(tok, []);
      }
      tokenIndex.get(tok).push(index);
    }

    // Index action
    if (intent.action) {
      if (!actionIndex.has(intent.action)) {
        actionIndex.set(intent.action, []);
      }
      actionIndex.get(intent.action).push(index);
    }

    // Index platform
    if (intent.platform) {
      if (!platformIndex.has(intent.platform)) {
        platformIndex.set(intent.platform, []);
      }
      platformIndex.get(intent.platform).push(index);
    }
  });

  return {
    totalVideos: indexedVideos.length,
    indexedVideos,
    exactCanonicalMap,
    tokenIndex,
    actionIndex,
    platformIndex
  };
}

/**
 * Rapidly find the top matching video candidates from the indexed channel.
 * Filters by platform, action group, and token intersection.
 * @param {Object} channelIndex - Pre-built channel index
 * @param {string} keyword - Search keyword
 * @returns {Array<Object>} List of promising candidate videos
 */
export function findChannelCandidates(channelIndex, keyword = '') {
  if (!channelIndex || !channelIndex.indexedVideos || channelIndex.indexedVideos.length === 0) {
    return [];
  }

  const keywordCanonical = canonicalKey(keyword);
  
  // 1. Instant check for exact canonical match
  if (channelIndex.exactCanonicalMap.has(keywordCanonical)) {
    const matchedIdx = channelIndex.exactCanonicalMap.get(keywordCanonical);
    return [channelIndex.indexedVideos[matchedIdx]];
  }

  const kwIntent = extractIntent(keyword);
  const kwTokens = tokenize(keyword, true);
  if (kwTokens.length === 0) return [];

  // Score candidate videos by token intersection
  const candidateScores = new Map(); // index -> score

  for (const token of kwTokens) {
    const matches = channelIndex.tokenIndex.get(token);
    if (matches) {
      for (const idx of matches) {
        candidateScores.set(idx, (candidateScores.get(idx) || 0) + 1);
      }
    }
  }

  if (candidateScores.size === 0) return [];

  // Collect top scoring candidates
  const scoredList = [];
  for (const [idx, score] of candidateScores.entries()) {
    const video = channelIndex.indexedVideos[idx];

    // Boost if platform matches
    let adjustedScore = score;
    if (kwIntent.platform && video.platform === kwIntent.platform) {
      adjustedScore += 3;
    }

    // Boost if action matches
    if (kwIntent.action && video.action === kwIntent.action) {
      adjustedScore += 3;
    } else if (kwIntent.actionGroup && video.actionGroup === kwIntent.actionGroup) {
      adjustedScore += 2;
    }

    scoredList.push({
      video,
      score: adjustedScore
    });
  }

  // Sort descending by score and return top candidates (up to 15)
  scoredList.sort((a, b) => b.score - a.score);
  return scoredList.slice(0, 15).map(item => item.video);
}
