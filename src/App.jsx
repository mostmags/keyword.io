import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Sparkles, ChevronDown, Copy, Check, Search, Tv, Settings, X, Activity } from 'lucide-react';
import './index.css';

import { canonicalKey } from './utils/normalizer.js';
import { buildChannelIndex } from './utils/channelIndexer.js';
import { evaluateCoverage } from './utils/coveredDetector.js';
import { generateQueryVariations, filterAndRankSuggestions } from './utils/queryExpander.js';
import { globalCache, CACHE_TTLS } from './utils/cacheManager.js';

function App() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [, setCursorPos] = useState(0);

  // Channel state
  const [channelId, setChannelId] = useState('');
  const [channelData, setChannelData] = useState(null);
  const [channelLoading, setChannelLoading] = useState(false);

  // Analysis & UI state
  const [analysis, setAnalysis] = useState({});
  const [copiedKeyword, setCopiedKeyword] = useState(null);

  // Workflow added state (persisted in localStorage)
  const [addedKeywords, setAddedKeywords] = useState({});

  // Action Words State
  const [savedPlatforms, setSavedPlatforms] = useState({});
  const [platformModalOpen, setPlatformModalOpen] = useState(false);
  const [platformInput, setPlatformInput] = useState('');
  const [isDiscoveringWords, setIsDiscoveringWords] = useState(false);

  // App routing and Modal
  const [currentView, setCurrentView] = useState('home');
  const [activeModalKeyword, setActiveModalKeyword] = useState(null);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState('all'); // 'all' | 'opportunity' | 'covered'

  const inputRef = useRef(null);
  const latestResultsRef = useRef([]);
  const channelDataRef = useRef(null);
  const channelIndexRef = useRef(null);
  const abortControllersRef = useRef({});
  const debounceTimeoutRef = useRef(null);
  const searchRequestIdRef = useRef(0);

  // Build and update channel index when channel data changes
  useEffect(() => {
    channelDataRef.current = channelData;
    if (channelData && channelData.videos) {
      channelIndexRef.current = buildChannelIndex(channelData.videos);
    } else {
      channelIndexRef.current = null;
    }
  }, [channelData]);

  // Initial data fetch and local storage hydration
  useEffect(() => {
    fetch('http://localhost:3001/api/config')
      .then(res => res.json())
      .then(data => {
        if (data.lastChannelId) {
          setChannelId(data.lastChannelId);
          fetchChannelData(data.lastChannelId, false);
        }
      })
      .catch(console.error);

    const savedActions = localStorage.getItem('kf_action_words');
    if (savedActions) {
      try { setSavedPlatforms(JSON.parse(savedActions)); } catch {}
    }

    const savedAdded = localStorage.getItem('kf_workflow_added');
    if (savedAdded) {
      try { setAddedKeywords(JSON.parse(savedAdded)); } catch {}
    }
  }, []);

  const fetchChannelData = async (id, forceRefresh) => {
    if (!id) return;
    setChannelLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/channel?id=${encodeURIComponent(id)}&refresh=${forceRefresh}`);
      const data = await res.json();
      if (data.error) {
        alert('Error: ' + data.error);
      } else {
        setChannelData(data);
        channelIndexRef.current = buildChannelIndex(data.videos || []);
      }
    } catch (e) {
      console.error(e);
      alert('Could not connect to backend server. Is it running?');
    }
    setChannelLoading(false);
  };

  const analyzeKeyword = async (keyword, reqId) => {
    if (searchRequestIdRef.current !== reqId) return;

    // Instant local evaluation against channel library
    const localEval = evaluateCoverage(keyword, channelIndexRef.current, null);

    // Check client-side persistent/memory cache for YouTube search results
    const cacheKey = `analyze_${keyword.toLowerCase().trim()}`;
    const cachedData = globalCache.get(cacheKey, CACHE_TTLS.ANALYZE);

    if (cachedData) {
      if (searchRequestIdRef.current !== reqId) return;
      const fullCoverage = evaluateCoverage(keyword, channelIndexRef.current, cachedData.channelRank);
      setAnalysis(prev => ({
        ...prev,
        [keyword]: {
          loading: false,
          ...fullCoverage,
          videos: cachedData.videos || []
        }
      }));
      return;
    }

    const controller = new AbortController();
    abortControllersRef.current[keyword] = controller;

    try {
      const currentChId = channelId || '';
      const analyzeUrl = `http://localhost:3001/api/analyze?keyword=${encodeURIComponent(keyword)}&channelId=${encodeURIComponent(currentChId)}`;

      const data = await globalCache.deduplicate(cacheKey, async () => {
        const res = await fetch(analyzeUrl, { signal: controller.signal });
        return await res.json();
      });

      globalCache.set(cacheKey, data);

      if (searchRequestIdRef.current !== reqId) return;

      const fullCoverage = evaluateCoverage(keyword, channelIndexRef.current, data.channelRank);

      setAnalysis(prev => ({
        ...prev,
        [keyword]: {
          loading: false,
          ...fullCoverage,
          videos: data.videos || []
        }
      }));
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error(e);
      if (searchRequestIdRef.current === reqId) {
        setAnalysis(prev => ({
          ...prev,
          [keyword]: {
            loading: false,
            ...localEval,
            error: true,
            videos: []
          }
        }));
      }
    } finally {
      delete abortControllersRef.current[keyword];
    }
  };

  const fetchJSONP = (q, cpParam) => {
    return new Promise((resolve) => {
      const callbackName = 'jsonp_cb_' + Math.round(1000000 * Math.random());
      window[callbackName] = (data) => {
        delete window[callbackName];
        if (data && data[1]) {
          resolve(data[1].map(item => item[0]));
        } else {
          resolve([]);
        }
      };

      const script = document.createElement('script');
      script.src = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}&cp=${cpParam}&jsonp=${callbackName}`;
      script.async = true;
      script.onload = () => document.body.removeChild(script);
      script.onerror = () => {
        delete window[callbackName];
        document.body.removeChild(script);
        resolve([]);
      };
      document.body.appendChild(script);
    });
  };

  const fetchSuggestions = async (text, cp) => {
    if (!text.trim()) {
      setSuggestions([]);
      latestResultsRef.current = [];
      setAnalysis({});
      return;
    }

    setLoading(true);
    const reqId = ++searchRequestIdRef.current;

    // Abort pending analyze requests from previous search
    Object.values(abortControllersRef.current).forEach(c => c.abort());
    abortControllersRef.current = {};

    try {
      const queries = generateQueryVariations(text, cp);
      const promises = queries.map(queryObj => {
        const queryKey = `sug_${queryObj.q}_${queryObj.cp}`;
        return globalCache.deduplicate(queryKey, () => fetchJSONP(queryObj.q, queryObj.cp));
      });

      const resultsArray = await Promise.all(promises);
      const mergedSet = new Set();
      resultsArray.forEach(results => {
        if (Array.isArray(results)) {
          results.forEach(item => mergedSet.add(item));
        }
      });

      const rawMerged = Array.from(mergedSet);
      // Multi-signal relevance ranking and completeness filter (up to 60 keywords)
      const finalResults = filterAndRankSuggestions(text, rawMerged, 10, 60);

      if (searchRequestIdRef.current !== reqId) return;

      setSuggestions(finalResults);
      latestResultsRef.current = finalResults;

      // Immediate 0ms local evaluation for responsive UI
      const initialAnalysis = {};
      finalResults.forEach(res => {
        const localCoverage = evaluateCoverage(res, channelIndexRef.current, null);
        initialAnalysis[res] = {
          loading: true,
          ...localCoverage,
          videos: []
        };
      });
      setAnalysis(initialAnalysis);

      // Debounce and queue backend analysis with concurrency limiter (4 at a time)
      if (finalResults.length > 0) {
        if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = setTimeout(() => {
          if (searchRequestIdRef.current !== reqId) return;

          const queue = [...finalResults];
          const concurrency = 4;
          let activeWorkers = 0;

          const runWorker = async () => {
            while (queue.length > 0 && searchRequestIdRef.current === reqId) {
              const kw = queue.shift();
              await analyzeKeyword(kw, reqId);
            }
            activeWorkers--;
          };

          for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
            activeWorkers++;
            runWorker();
          }
        }, 300);
      }
    } catch (e) {
      console.error(e);
      if (searchRequestIdRef.current === reqId) {
        setSuggestions([]);
        latestResultsRef.current = [];
      }
    } finally {
      if (searchRequestIdRef.current === reqId) {
        setLoading(false);
      }
    }
  };

  const handleInputChange = (e) => {
    const text = e.target.value;
    const cp = e.target.selectionStart;
    setQuery(text);
    setCursorPos(cp);
    fetchSuggestions(text, cp);
  };

  const handleSelectUpdate = (e) => {
    const cp = e.target.selectionStart;
    setCursorPos(cp);
  };

  const markKeywordAsAdded = (keyword) => {
    const canon = canonicalKey(keyword);
    const updated = { ...addedKeywords, [canon]: true };
    setAddedKeywords(updated);
    try {
      localStorage.setItem('kf_workflow_added', JSON.stringify(updated));
    } catch {}
  };

  const toggleAdded = (keyword, e) => {
    e.stopPropagation();
    const canon = canonicalKey(keyword);
    const updated = { ...addedKeywords };
    if (updated[canon]) {
      delete updated[canon];
    } else {
      updated[canon] = true;
    }
    setAddedKeywords(updated);
    try {
      localStorage.setItem('kf_workflow_added', JSON.stringify(updated));
    } catch {}
  };

  const copyToClipboard = (keyword, e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(keyword);
    setCopiedKeyword(keyword);
    markKeywordAsAdded(keyword);
    setTimeout(() => setCopiedKeyword(null), 2000);
  };

  const discoverActionWords = async () => {
    const topic = platformInput.trim().toLowerCase();
    if (!topic) return;
    setIsDiscoveringWords(true);

    try {
      const res = await fetch(`http://localhost:3001/api/action-words?topic=${encodeURIComponent(topic)}`);
      const data = await res.json();
      if (data.actionWords) {
        const newSaved = { ...savedPlatforms, [topic]: data.actionWords };
        setSavedPlatforms(newSaved);
        localStorage.setItem('kf_action_words', JSON.stringify(newSaved));
        setPlatformInput('');
        setPlatformModalOpen(false);
      }
    } catch (e) {
      console.error('Error discovering action words:', e);
      alert('Error fetching action words.');
    }
    setIsDiscoveringWords(false);
  };

  let activeActionWords = [];
  let currentPlatform = '';

  const lowerQuery = query.toLowerCase();
  if (lowerQuery.startsWith('how to ')) {
    const remainder = lowerQuery.substring(7);
    const match1 = remainder.match(/^([a-z]+)\s+(.+)$/);
    if (match1) {
      const prefix = match1[1];
      const rest = match1[2].trim();

      const knownPlatform = Object.keys(savedPlatforms).find(p => rest === p || p.startsWith(rest));
      if (knownPlatform) {
        currentPlatform = knownPlatform;
        activeActionWords = savedPlatforms[knownPlatform].filter(w => w.startsWith(prefix) && w !== prefix);
      }
    }
  }

  const insertActionWord = (word) => {
    const newQuery = `how to ${word} ${currentPlatform}`;
    const newCursorPos = newQuery.length;

    setQuery(newQuery);
    setCursorPos(newCursorPos);

    if (inputRef.current) {
      inputRef.current.focus();
      setTimeout(() => {
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
        fetchSuggestions(newQuery, newCursorPos);
      }, 0);
    }
  };

  const uniqueCount = suggestions.filter(s => {
    const item = analysis[s];
    return !item || item.isUnique || item.category === 'unique';
  }).length;

  const coveredCount = suggestions.filter(s => {
    const item = analysis[s];
    return item && (item.isCovered || item.category === 'covered_channel' || item.category === 'covered_ranking');
  }).length;

  const displayedSuggestions = suggestions.filter(s => {
    if (selectedCategoryFilter === 'all') return true;
    const item = analysis[s];
    if (selectedCategoryFilter === 'opportunity') {
      return !item || item.isUnique || item.category === 'unique';
    }
    if (selectedCategoryFilter === 'covered') {
      return item && (item.isCovered || item.category === 'covered_channel' || item.category === 'covered_ranking');
    }
    return true;
  });

  return (
    <div className="app-container">
      <div className="glass-background"></div>

      <header className="app-header">
        <div className="header-left">
          <div className="logo-icon"><Activity size={22} /></div>
          <h1>SearchPulse</h1>
        </div>
        <button className="settings-btn" onClick={() => setCurrentView(currentView === 'home' ? 'settings' : 'home')}>
          {currentView === 'home' ? <Settings size={20} /> : <X size={20} />}
        </button>
      </header>

      {currentView === 'settings' ? (
        <main className="main-content">
          <div className="channel-sync">
            <div className="channel-header">
              <Tv size={18} />
              <h2>Channel Sync</h2>
            </div>
            <p className="channel-desc">Enter a YouTube Channel ID or handle (e.g. @MrBeast) to check if keywords are already covered by this channel.</p>
            <div className="channel-input-group">
              <input
                type="text"
                placeholder="@channelhandle"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchChannelData(channelId, false)}
              />
              <button onClick={() => fetchChannelData(channelId, false)} disabled={channelLoading}>
                {channelLoading ? 'Syncing...' : 'Sync'}
              </button>
              {channelData && (
                <button onClick={() => fetchChannelData(channelId, true)} disabled={channelLoading} className="refresh-btn" title="Force Refresh">
                  Refresh
                </button>
              )}
            </div>
            {channelData && (
              <div className="channel-success">
                Synced with <strong>{channelData.channelName}</strong> ({channelData.videos.length} videos)
              </div>
            )}
          </div>
        </main>
      ) : (
        <main className="main-content">
          <section className="search-section">
            <div className="search-bar-wrapper">
              <Search className="search-icon" size={22} />
              <input
                ref={inputRef}
                type="text"
                className="search-input-main"
                placeholder="e.g. how to make a..."
                value={query}
                onChange={handleInputChange}
                onKeyUp={handleSelectUpdate}
                onClick={handleSelectUpdate}
                autoFocus
              />
              {/* Discover Action Words Trigger */}
              <button
                className="discover-btn"
                onClick={() => setPlatformModalOpen(true)}
                title="Discover missing action words"
              >
                <Sparkles size={16} />
                <span>Action Words</span>
              </button>
            </div>

            {/* Action Words Display */}
            {activeActionWords.length > 0 && (
              <div className="action-words-container">
                <span className="action-words-label">Suggested verbs:</span>
                <div className="action-words-scroll">
                  {activeActionWords.map(word => (
                    <button
                      key={word}
                      className="action-word-pill"
                      onClick={() => insertActionWord(word)}
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {suggestions.length > 0 && (
            <>
              <div className="results-toolbar">
                <div className="category-filters">
                  <button
                    className={`category-filter-btn ${selectedCategoryFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setSelectedCategoryFilter('all')}
                  >
                    All ({suggestions.length})
                  </button>
                  <button
                    className={`category-filter-btn opportunity ${selectedCategoryFilter === 'opportunity' ? 'active' : ''}`}
                    onClick={() => setSelectedCategoryFilter('opportunity')}
                  >
                    <Sparkles size={14} />
                    Opportunities ({uniqueCount})
                  </button>
                  <button
                    className={`category-filter-btn covered ${selectedCategoryFilter === 'covered' ? 'active' : ''}`}
                    onClick={() => setSelectedCategoryFilter('covered')}
                  >
                    <CheckCircle2 size={14} />
                    Covered ({coveredCount})
                  </button>
                </div>
              </div>

              <div className="results-grid">
                {displayedSuggestions.map((suggestion, index) => {
                  const itemAnalysis = analysis[suggestion] || {};
                  const isCopied = copiedKeyword === suggestion;
                  const isAdded = Boolean(addedKeywords[canonicalKey(suggestion)]);
                  const isCoveredChannel = itemAnalysis.category === 'covered_channel' || (itemAnalysis.isCoveredByChannel);
                  const isCoveredRank = itemAnalysis.category === 'covered_ranking' || (itemAnalysis.isCoveredByRank);
                  const isUnique = !isCoveredChannel && !isCoveredRank;

                  return (
                    <div
                      key={index}
                      className={`result-card ${isAdded ? 'added-to-workflow' : ''}`}
                    >
                      <div className="result-main-row">
                        <button
                          className="keyword-btn"
                          onClick={(e) => copyToClipboard(suggestion, e)}
                          title="Click to copy and add to workflow"
                        >
                          <span className="keyword-text">{suggestion}</span>
                          {isAdded && (
                            <span
                              className="added-badge"
                              onClick={(e) => toggleAdded(suggestion, e)}
                              title="Added to workflow (click to toggle)"
                            >
                              Added
                            </span>
                          )}
                          <span className="copy-indicator">
                            {isCopied ? <Check size={16} className="text-green" /> : <Copy size={16} className="text-gray" />}
                          </span>
                        </button>

                        <div className="result-actions">
                          {!itemAnalysis.loading && (
                            <>
                              {isCoveredRank && (
                                <span
                                  className="status-badge ranking"
                                  title={`Your channel ranks #${itemAnalysis.channelRank?.position} in search results`}
                                >
                                  Ranks #{itemAnalysis.channelRank?.position}
                                </span>
                              )}
                              {isCoveredChannel && (
                                <span
                                  className="status-badge covered"
                                  title="Covered by your channel video"
                                >
                                  Covered
                                </span>
                              )}
                              {isUnique && (
                                <span
                                  className="status-badge opportunity"
                                  title="Untapped opportunity to target"
                                >
                                  Opportunity
                                </span>
                              )}
                            </>
                          )}

                          <div className="analysis-status">
                            {itemAnalysis.loading ? (
                              <div className="loading-spinner"></div>
                            ) : (
                              <>
                                {isCoveredChannel && (
                                  <div className="status-icon-wrapper covered tooltip-wrap">
                                    <CheckCircle2 size={18} />
                                    <div className="tooltip tooltip-debug">
                                      <div className="tooltip-debug-header">
                                        <span>Covered in Channel</span>
                                      </div>
                                      <div className="tooltip-debug-reasons">
                                        {itemAnalysis.reasons && itemAnalysis.reasons.map((r, i) => (
                                          <div key={i}>• {r}</div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {isCoveredRank && (
                                  <div className="status-icon-wrapper covered-ranking tooltip-wrap">
                                    <CheckCircle2 size={18} />
                                    <div className="tooltip tooltip-debug">
                                      <div className="tooltip-debug-header">
                                        <span>Covered (Rank #{itemAnalysis.channelRank?.position})</span>
                                      </div>
                                      <div className="tooltip-debug-reasons">
                                        {itemAnalysis.reasons && itemAnalysis.reasons.map((r, i) => (
                                          <div key={i}>• {r}</div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {isUnique && (
                                  <div className="status-icon-wrapper unique tooltip-wrap">
                                    <Sparkles size={18} />
                                    <div className="tooltip tooltip-debug">
                                      <div className="tooltip-debug-header">
                                        <span>Unique Opportunity</span>
                                      </div>
                                      <div className="tooltip-debug-reasons">
                                        {itemAnalysis.reasons && itemAnalysis.reasons.length > 0 ? (
                                          itemAnalysis.reasons.map((r, i) => <div key={i}>• {r}</div>)
                                        ) : (
                                          <div>• Untapped opportunity: Not covered and not ranking in top 2</div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                          </div>

                          {itemAnalysis.videos && itemAnalysis.videos.length > 0 && (
                            <button
                              className="expand-btn"
                              onClick={() => setActiveModalKeyword(suggestion)}
                              title="View top videos"
                            >
                              <ChevronDown size={20} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {query && !loading && suggestions.length === 0 && (
            <div className="empty-state">
              <p>No suggestions found for this query.</p>
            </div>
          )}
        </main>
      )}

      {activeModalKeyword && analysis[activeModalKeyword] && analysis[activeModalKeyword].videos && (
        <div className="modal-overlay" onClick={() => setActiveModalKeyword(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setActiveModalKeyword(null)}><X size={20} /></button>
            <h2>Top Ranking Videos</h2>
            <p className="modal-subtitle">for "{activeModalKeyword}"</p>

            <div className="modal-videos">
              {analysis[activeModalKeyword].videos.map((v, i) => (
                <a key={i} href={`https://youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" className="modal-video-item">
                  <div className="modal-video-rank">{i + 1}</div>
                  <img src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`} alt={v.title} className="modal-video-thumb" />
                  <div className="modal-video-info">
                    <span className="modal-video-title">{v.title}</span>
                    <div className="modal-video-stats">
                      <span className="modal-video-views">{v.views || 'N/A views'}</span>
                      <span className="modal-video-subs">• {v.subs || 'N/A'} subs</span>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {platformModalOpen && (
        <div className="modal-overlay" onClick={() => !isDiscoveringWords && setPlatformModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => !isDiscoveringWords && setPlatformModalOpen(false)}><X size={20} /></button>
            <h2>Discover Action Words</h2>
            <p className="modal-subtitle">Enter a platform or app name to extract all action verbs (e.g. "google ads")</p>

            <div className="channel-input-group" style={{marginTop: '20px', marginBottom: '20px'}}>
              <input
                type="text"
                placeholder="e.g. squarespace"
                value={platformInput}
                onChange={e => setPlatformInput(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && discoverActionWords()}
              />
              <button
                onClick={discoverActionWords}
                disabled={isDiscoveringWords || !platformInput.trim()}
              >
                {isDiscoveringWords ? 'Discovering...' : 'Discover'}
              </button>
            </div>

            {Object.keys(savedPlatforms).length > 0 && (
              <div style={{marginTop: '16px', borderTop: '1px solid #eee', paddingTop: '16px'}}>
                <h4 style={{fontSize: '14px', color: '#86868b', marginBottom: '8px', fontWeight: '500'}}>Saved Platforms:</h4>
                <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                  {Object.keys(savedPlatforms).map(p => (
                    <span key={p} style={{background: '#f5f5f7', padding: '4px 10px', borderRadius: '12px', fontSize: '13px', color: '#1d1d1f'}}>
                      {p} ({savedPlatforms[p].length})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {copiedKeyword && (
        <div className="toast-notification">
          <CheckCircle2 size={18} />
          Copied to clipboard & added to workflow
        </div>
      )}
    </div>
  );
}

export default App;
