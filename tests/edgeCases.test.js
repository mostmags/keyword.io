import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalKey } from '../src/utils/normalizer.js';
import { areActionsOpposing, compareObjects, extractIntent } from '../src/utils/intentExtractor.js';
import { rankKeywords, scoreKeywordRelevance } from '../src/utils/relevanceRanker.js';
import { buildChannelIndex } from '../src/utils/channelIndexer.js';
import { evaluateCoverage, calculateOpportunityScore } from '../src/utils/coveredDetector.js';
import { generateQueryVariations, filterAndRankSuggestions } from '../src/utils/queryExpander.js';
import { globalCache } from '../src/utils/cacheManager.js';

test('Test 1 — Exact match detection', () => {
  const keyword = 'how to add debit card to robinhood';
  const videos = [
    { id: 'vid1', title: 'How to add debit card to robinhood' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const result = evaluateCoverage(keyword, channelIndex, null);

  assert.strictEqual(result.status, 'covered', 'Expected status to be covered');
  assert.ok(result.coveredScore >= 90, `Expected score >= 90, got ${result.coveredScore}`);
  assert.strictEqual(result.matchedVideo?.id, 'vid1');
});

test('Test 2 — Same intent, different wording is NOT covered (strict title rule)', () => {
  const keyword = 'how to add debit card to robinhood';
  const videos = [
    { id: 'vid2', title: 'How to link a debit card with Robinhood' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const result = evaluateCoverage(keyword, channelIndex, null);

  // Strict rule: only an exact title match (or top-2 ranking) counts as covered.
  assert.strictEqual(result.status, 'unique', `Expected unique for reworded title, got ${result.status}`);
  assert.strictEqual(result.coveredScore, 0, `Expected score 0, got ${result.coveredScore}`);
});

test('Test 3 — Existing #1 ranking in YouTube search results', () => {
  const keyword = 'how to add debit card to robinhood';
  const videos = [
    { id: 'vid3', title: 'How to fund robinhood with debit card' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const channelRank = {
    position: 1,
    videoId: 'vid3',
    title: 'How to fund robinhood with debit card'
  };
  const result = evaluateCoverage(keyword, channelIndex, channelRank);

  assert.strictEqual(result.status, 'covered', 'Expected #1 ranking to be COVERED');
  assert.ok(result.coveredScore >= 90, `Expected score >= 90, got ${result.coveredScore}`);
  assert.ok(result.reasons.some(r => r.includes('ranks #1')), 'Expected reason to mention #1 rank');
});

test('Test 4 — Opposite action (Antonym Protection)', () => {
  const keyword = 'how to remove debit card from robinhood';
  const videos = [
    { id: 'vid1', title: 'how to add debit card to robinhood' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const result = evaluateCoverage(keyword, channelIndex, null);

  assert.strictEqual(result.status, 'unique', 'Opposite action must NOT be marked covered');
  assert.ok(result.coveredScore < 40, `Expected score < 40 for antonyms, got ${result.coveredScore}`);
  assert.ok(areActionsOpposing('remove', 'add'), 'remove and add must be recognized as opposing');
});

test('Test 5 — Different object isolation', () => {
  const keyword = 'how to add bank account to robinhood';
  const videos = [
    { id: 'vid1', title: 'how to add debit card to robinhood' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const result = evaluateCoverage(keyword, channelIndex, null);

  assert.strictEqual(result.status, 'unique', 'Different objects (bank account vs debit card) must be UNIQUE');
  assert.ok(result.coveredScore < 40, `Expected score < 40 for conflicting objects, got ${result.coveredScore}`);
  assert.strictEqual(compareObjects(['bank account'], ['debit card']), 0.0, 'Payment objects must conflict');
});

test('Test 6 — Workflow state persistence & canonization', () => {
  const rawKeyword = 'How To Add A Debit Card To Robinhood';
  const queryVariation = 'how to add debit card to robinhood';
  
  const canon1 = canonicalKey(rawKeyword);
  const canon2 = canonicalKey(queryVariation);

  assert.strictEqual(canon1, canon2, 'Both representations must produce the same canonical key');

  // Simulate workflow map
  const workflowMap = { [canon1]: true };
  assert.ok(Boolean(workflowMap[canonicalKey('how to add debit card to robinhood')]));
});

test('Test 7 — Caching and deduplication', async () => {
  globalCache.clear();
  let apiCallCount = 0;

  const mockApiCall = async () => {
    apiCallCount++;
    return { data: 'test_result' };
  };

  // Concurrent deduplication
  const [res1, res2] = await Promise.all([
    globalCache.deduplicate('test_query', mockApiCall),
    globalCache.deduplicate('test_query', mockApiCall)
  ]);

  assert.strictEqual(apiCallCount, 1, 'In-flight deduplication must only fire 1 network call');
  assert.deepStrictEqual(res1, res2);

  // Cache retrieval
  globalCache.set('test_key', { value: 123 });
  const cached = globalCache.get('test_key', 60000);
  assert.deepStrictEqual(cached, { value: 123 });
});

test('Test 8 — Query relevance ranking (send e robinhood)', () => {
  const query = 'how to send e robinhood';
  const candidates = [
    'robinhood trading tutorial',
    'how to send money on robinhood',
    'how to send eth on robinhood',
    'how to send eth through robinhood',
    'how to send eth from robinhood to kraken',
    'how to send ethereum from robinhood',
    'robinhood account setup guide'
  ];

  const ranked = rankKeywords(query, candidates);
  const top4Keywords = ranked.slice(0, 4).map(r => r.keyword);

  // Top positions should contain eth / ethereum keywords
  const hasEthInTop = top4Keywords.some(k => k.includes('eth') || k.includes('ethereum'));
  assert.ok(hasEthInTop, 'Keywords matching prefix e (eth/ethereum) must rank in top positions');

  // Verify specific scores: eth should score higher than unrelated tutorial
  const ethScore = scoreKeywordRelevance(query, 'how to send eth on robinhood', 0);
  const unrelatedScore = scoreKeywordRelevance(query, 'robinhood trading tutorial', 0);
  assert.ok(ethScore > unrelatedScore, `eth candidate (${ethScore}) must outrank unrelated (${unrelatedScore})`);
});

test('Test 9 — Similar wording vs Opposite action similarity', () => {
  const base = 'how to send money on robinhood';
  const variant1 = 'how to send money through robinhood';
  const variant2 = 'how do i send money on robinhood';
  const variant3 = 'robinhood how to send money';
  const opposite = 'how to receive money on robinhood';

  // Wording variants should have high token overlap and share intent
  const scoreVar1 = scoreKeywordRelevance(base, variant1);
  const scoreVar2 = scoreKeywordRelevance(base, variant2);
  const scoreVar3 = scoreKeywordRelevance(base, variant3);
  const scoreOpposite = scoreKeywordRelevance(base, opposite);

  assert.ok(scoreVar1 >= 75, `Expected variant1 >= 75, got ${scoreVar1}`);
  assert.ok(scoreVar2 >= 70, `Expected variant2 >= 70, got ${scoreVar2}`);
  assert.ok(scoreVar3 >= 60, `Expected variant3 >= 60, got ${scoreVar3}`);

  // Opposite action must be penalized
  assert.ok(areActionsOpposing('send', 'receive'), 'send and receive are opposing');
  assert.ok(scoreVar1 > scoreOpposite, 'Same-action variation must outrank opposite action');
});

test('Test 10 — Opportunity score calculation', () => {
  // High relevance, not covered, no channel rank -> High opportunity
  const highOpp = calculateOpportunityScore(90, 0, false);
  assert.ok(highOpp >= 80, `Expected high opportunity >= 80, got ${highOpp}`);

  // High relevance, but channel ranks #1 (covered) -> Low opportunity
  const lowOpp = calculateOpportunityScore(90, 95, true);
  assert.ok(lowOpp <= 25, `Expected low opportunity <= 25, got ${lowOpp}`);
});

test('Test 11 — Normalization consistency', () => {
  const norm1 = canonicalKey('How To Add A Debit Card To Robinhood');
  const norm2 = canonicalKey('how to add debit card to robinhood');
  const norm3 = canonicalKey('how to add debit cards to robinhood');

  assert.strictEqual(norm1, norm2, 'Casing and stop-word a should normalize identically');
  assert.strictEqual(norm1, norm3, 'Plural cards should normalize to card');
});

test('Test 12 — Query Expander creates multi-dimensional variations', () => {
  const query = 'how to send money on robinhood';
  const variations = generateQueryVariations(query, query.length);

  assert.ok(variations.length >= 2, 'Should generate multiple variation queries');
  assert.ok(variations.some(v => v.q.includes('through') || v.q.includes('how do i') || v.q.startsWith('robinhood')));

  const rawList = [
    'how to send money on robinhood',
    'how to send money through robinhood',
    'how to cook a steak', // completely irrelevant noise
    'how to send eth on robinhood'
  ];
  const filtered = filterAndRankSuggestions(query, rawList, 20);
  assert.ok(!filtered.includes('how to cook a steak'), 'Irrelevant noise must be pruned');
  assert.ok(filtered.includes('how to send money on robinhood'));
});

test('Test 13 — 3-Category Classification System (Covered Channel vs Covered Ranking vs Unique)', () => {
  const videos = [
    { id: 'vid1', title: 'How to buy crypto on Robinhood' }
  ];
  const channelIndex = buildChannelIndex(videos);

  // Category 1: Covered in Channel
  const res1 = evaluateCoverage('how to buy crypto on robinhood', channelIndex, null);
  assert.strictEqual(res1.category, 'covered_channel');
  assert.strictEqual(res1.isCovered, true);
  assert.strictEqual(res1.isCoveredByChannel, true);
  assert.strictEqual(res1.isCoveredByRank, false);

  // Category 2: Not covered in channel, but channel ranks #1 in search results
  const res2 = evaluateCoverage('how to transfer bitcoin to robinhood', channelIndex, {
    position: 1,
    videoId: 'vid_rank',
    title: 'How to transfer crypto to robinhood'
  });
  assert.strictEqual(res2.category, 'covered_ranking');
  assert.strictEqual(res2.isCovered, true);
  assert.strictEqual(res2.isCoveredByChannel, false);
  assert.strictEqual(res2.isCoveredByRank, true);

  // Category 3: Not covered in channel, channel does not rank in top 2
  const res3 = evaluateCoverage('how to transfer bitcoin to robinhood', channelIndex, null);
  assert.strictEqual(res3.category, 'unique');
  assert.strictEqual(res3.isCovered, false);
  assert.strictEqual(res3.isUnique, true);
});

test('Test 14 — Strict Top 2 Rank Threshold (#1 & #2 Covered, #3+ Unique Opportunity)', () => {
  const channelIndex = buildChannelIndex([]);

  // Rank #2 -> Covered (ranking)
  const rank2Res = evaluateCoverage('how to deposit checks on robinhood', channelIndex, {
    position: 2,
    videoId: 'v2',
    title: 'Robinhood check deposit guide'
  });
  assert.strictEqual(rank2Res.category, 'covered_ranking');
  assert.strictEqual(rank2Res.isCovered, true);

  // Rank #3 -> NOT covered! Must be Unique opportunity!
  const rank3Res = evaluateCoverage('how to deposit checks on robinhood', channelIndex, {
    position: 3,
    videoId: 'v3',
    title: 'Robinhood check deposit guide'
  });
  assert.strictEqual(rank3Res.category, 'unique');
  assert.strictEqual(rank3Res.isCovered, false);
  assert.strictEqual(rank3Res.isUnique, true);

  // Rank #5 -> Unique opportunity
  const rank5Res = evaluateCoverage('how to deposit checks on robinhood', channelIndex, {
    position: 5,
    videoId: 'v5',
    title: 'Robinhood check deposit guide'
  });
  assert.strictEqual(rank5Res.category, 'unique');
  assert.strictEqual(rank5Res.isCovered, false);
  assert.strictEqual(rank5Res.isUnique, true);
});

test('Test 15 — Percentage Removal: Reasons do NOT contain raw percentage scores', () => {
  const videos = [
    { id: 'vid1', title: 'How to add bank account on Robinhood (Full Guide)' }
  ];
  const channelIndex = buildChannelIndex(videos);
  const result = evaluateCoverage('how to add bank account on robinhood', channelIndex, null);

  assert.strictEqual(result.category, 'covered_channel');
  for (const reason of result.reasons) {
    assert.ok(!reason.includes('%'), `Reason must not include raw percentage: "${reason}"`);
  }
});

test('Test 16 — Natural Query Expansion: Discovers question forms and prepositions without artificial modifier concatenation', () => {
  const query = 'how to send money on robinhood';
  const variations = generateQueryVariations(query, query.length);

  assert.ok(variations.length >= 4, `Expected at least 4 variations, got ${variations.length}`);
  assert.ok(variations.some(v => v.q.includes('how do i')), 'Expected question form variation');
  assert.ok(variations.some(v => v.q.includes('to robinhood') || v.q.includes('in robinhood')), 'Expected preposition variation');
  assert.ok(variations.some(v => v.q.startsWith('robinhood')), 'Expected platform first variation');
  // CRITICAL: Must NEVER blindly concatenate synthetic modifiers like 'without', 'step by step', etc.
  assert.ok(!variations.some(v => v.q.includes('without')), 'Must NOT contain artificial "without" concatenation');
  assert.ok(!variations.some(v => v.q.includes('for beginners')), 'Must NOT contain artificial "for beginners" concatenation');
  assert.ok(!variations.some(v => v.q.includes('step by step')), 'Must NOT contain artificial "step by step" concatenation');
});

test('Test 17 — Long-Tail Relevance: Long-tail phrases are not penalized for length', () => {
  const query = 'how to send money on robinhood';
  const baseCandidate = 'how to send money on robinhood';
  const longTailCandidate = 'how to send money on robinhood without bank account';

  const baseScore = scoreKeywordRelevance(query, baseCandidate);
  const longTailScore = scoreKeywordRelevance(query, longTailCandidate);

  // Long-tail candidate must have high relevance (>= 80) and not be severely penalized
  assert.ok(longTailScore >= 80, `Expected longTailScore >= 80, got ${longTailScore}`);
  assert.ok(baseScore >= longTailScore, 'Exact query matches 100, long tail matches close to 100');
});

test('Test 18 — Platform Isolation: Uncovered platform (PhonePe) must NOT match other platforms (Razorpay, Quickbooks)', () => {
  const videos = [
    { id: 'v1', title: 'How to Add Bank Account in Razor Pay (Full Guide)' },
    { id: 'v2', title: 'How to Add Another Bank Account to Quickbooks Online (Full Guide)' },
    { id: 'v3', title: 'How to Add Credit Card Fees to Quickbooks Invoice (Full Guide)' }
  ];
  const channelIndex = buildChannelIndex(videos);

  // 1. PhonePe query must be UNIQUE OPPORTUNITY because user hasn't made PhonePe videos
  const phonepeRes = evaluateCoverage('how to add bank account in phonepe', channelIndex, null);
  assert.strictEqual(phonepeRes.category, 'unique', 'PhonePe must not match Razor Pay');
  assert.strictEqual(phonepeRes.isCovered, false);
  assert.strictEqual(phonepeRes.matchedVideo, null);

  // 2. Razor Pay query MUST match Razor Pay video
  const razorpayRes = evaluateCoverage('how to add bank account in razor pay', channelIndex, null);
  assert.strictEqual(razorpayRes.category, 'covered_channel', 'Razor Pay query must match Razor Pay video');
  assert.strictEqual(razorpayRes.isCovered, true);
  assert.strictEqual(razorpayRes.matchedVideo?.id, 'v1');

  // 3. Quickbooks query MUST match Quickbooks video
  const qbRes = evaluateCoverage('how to add another bank account to quickbooks online', channelIndex, null);
  assert.strictEqual(qbRes.category, 'covered_channel', 'Quickbooks query must match Quickbooks video');
  assert.strictEqual(qbRes.isCovered, true);
  assert.strictEqual(qbRes.matchedVideo?.id, 'v2');
});

test('Test 19 — Authentic YouTube Suggest Prioritization & Zero Synthetic Modifier Noise (how to add b botim)', () => {
  const query = 'how to add b botim';
  
  // 1. Verify query variations do NOT contain artificial modifiers
  const variations = generateQueryVariations(query, query.length);
  assert.ok(!variations.some(v => v.q.includes('without')), 'Must not contain "without" modifier');
  assert.ok(!variations.some(v => v.q.includes('for beginners')), 'Must not contain "for beginners" modifier');
  assert.ok(!variations.some(v => v.q.includes('step by step')), 'Must not contain "step by step" modifier');
  // Cleaned query without dangling single letter should be generated
  assert.ok(variations.some(v => v.q === 'how to add botim'), 'Expected normalized query without dangling single character');

  // 2. Candidates from YouTube search suggest vs synthetic garbage vs unrelated noise
  const authenticCandidates = [
    'how to add botim number',
    'how to add botim',
    'how to add botim card in samsung wallet',
    'how to add beneficiary in botim app',
    'how to add bank account in botim'
  ];
  const unrelatedNoise = [
    'how to add top and bottom blur in capcut',
    'how to add bottom navigation bar in shopify'
  ];

  // Authentic suggestions must score high (>= 80)
  for (const kw of authenticCandidates) {
    const s = scoreKeywordRelevance(query, kw);
    assert.ok(s >= 80, `Expected authentic candidate "${kw}" score >= 80, got ${s}`);
  }

  // Unrelated noise (e.g. CapCut blur, Shopify nav bar) must be severely penalized (score <= 10)
  for (const kw of unrelatedNoise) {
    const s = scoreKeywordRelevance(query, kw);
    assert.ok(s <= 10, `Expected noise "${kw}" score <= 10, got ${s}`);
  }

  // Ranking test: authentic candidates must outrank unrelated noise
  const allCandidates = [...unrelatedNoise, ...authenticCandidates];
  const ranked = rankKeywords(query, allCandidates);
  const topKeywords = ranked.slice(0, 5).map(r => r.keyword);
  for (const kw of authenticCandidates) {
    assert.ok(topKeywords.includes(kw), `Expected "${kw}" to be in top keywords`);
  }
  for (const kw of unrelatedNoise) {
    assert.ok(!topKeywords.includes(kw), `Expected "${kw}" NOT to be in top keywords`);
  }
});

test('Test 20 — Botim Platform Recognition & Isolation', () => {
  const botimIntent = extractIntent('how to add bank account in botim');
  assert.strictEqual(botimIntent.platform, 'botim', 'botim must be recognized as a known platform');

  const capcutIntent = extractIntent('how to add top and bottom blur in capcut');
  assert.strictEqual(capcutIntent.platform, 'capcut', 'capcut must be recognized as a known platform');
  assert.notStrictEqual(botimIntent.platform, capcutIntent.platform, 'botim and capcut must be distinct platforms');
});

test('Test 21 — Strict Coverage: similar-but-different titles must NOT be covered', () => {
  const videos = [
    { id: 'v1', title: 'How to Activate Green Status on Cash App (Full Guide)' },
    { id: 'v2', title: 'How to Activate Overdraft on Cash App (Full Guide)' },
    { id: 'v3', title: 'How to Create Bitcoin Wallet on Cash App (Full Guide)' }
  ];
  const channelIndex = buildChannelIndex(videos);

  // Each of these shares platform + action with an existing video but is a
  // different topic — must be UNIQUE under the strict title rule.
  const notCovered = [
    'how to activate cash app green',           // vs "Activate Green Status..." — different wording
    'how to activate cash app card',
    'how to activate cash app borrow',
    'how to activate bitcoin on cash app',
    'how to activate cash app account'
  ];
  for (const kw of notCovered) {
    const r = evaluateCoverage(kw, channelIndex, null);
    assert.strictEqual(r.category, 'unique', `"${kw}" must be unique, got ${r.category} (matched: ${r.matchedVideo?.title})`);
  }

  // Exact title match (ignoring casing/boilerplate) IS covered
  const exact = evaluateCoverage('how to activate overdraft on cash app', channelIndex, null);
  assert.strictEqual(exact.category, 'covered_channel');
  assert.strictEqual(exact.matchedVideo?.id, 'v2');
});

test('Test 22 — Coverage via rank only when no exact title exists', () => {
  const videos = [{ id: 'v1', title: 'How to Activate Cash App Card (Full Guide)' }];
  const channelIndex = buildChannelIndex(videos);

  // No title match + channel ranks #2 -> covered_ranking
  const rankRes = evaluateCoverage('how to activate cash app card 2025', channelIndex, {
    position: 2,
    videoId: 'v1',
    title: 'How to Activate Cash App Card (Full Guide)'
  });
  assert.strictEqual(rankRes.category, 'covered_ranking');
  assert.ok(rankRes.reasons.some(r => r.includes('#2')));

  // No title match + rank #3 -> unique
  const rank3 = evaluateCoverage('how to activate cash app card 2025', channelIndex, {
    position: 3,
    videoId: 'v1',
    title: 'How to Activate Cash App Card (Full Guide)'
  });
  assert.strictEqual(rank3.category, 'unique');
});

test('Test 23 — Mid-typing fragment ranking: "how to activate b cash app" must prioritize b-words', () => {
  const query = 'how to activate b cash app';
  const candidates = [
    'how to activate cash app card before it arrives',   // 'b' matches trailing 'before' — noise
    'how to activate bitcoin in cash app',               // completes the 'b' fragment
    'how to activate borrow on cash app',                // completes the 'b' fragment
    'how to activate cash app card',                     // ignores the 'b' entirely
    'how to activate cash app'
  ];

  const ranked = rankKeywords(query, candidates);
  const order = ranked.map(r => r.keyword);

  // Bitcoin/borrow completions must outrank the "before it arrives" noise and
  // the keyword that ignores the typed fragment entirely.
  assert.ok(
    order.indexOf('how to activate bitcoin in cash app') < order.indexOf('how to activate cash app card before it arrives'),
    `"bitcoin" completion must outrank "before" noise: ${JSON.stringify(order)}`
  );
  assert.ok(
    order.indexOf('how to activate borrow on cash app') < order.indexOf('how to activate cash app card before it arrives'),
    `"borrow" completion must outrank "before" noise: ${JSON.stringify(order)}`
  );
  assert.ok(
    order.indexOf('how to activate bitcoin in cash app') < order.indexOf('how to activate cash app card'),
    `"bitcoin" completion must outrank fragment-ignoring keyword: ${JSON.stringify(order)}`
  );
});

