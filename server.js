import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const cacheDir = path.join(__dirname, '.cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir);
}

const configFile = path.join(__dirname, 'config.json');

app.get('/api/config', (req, res) => {
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      res.json(config);
    } catch {
      res.json({});
    }
  } else {
    res.json({});
  }
});

const getYouTubeClient = () => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;
  return google.youtube({ version: 'v3', auth: apiKey });
};

app.get('/api/channel', async (req, res) => {
  const identifier = req.query.id;
  const forceRefresh = req.query.refresh === 'true';

  if (!identifier) {
    return res.status(400).json({ error: 'Missing channel identifier' });
  }

  const cacheFile = path.join(cacheDir, `${encodeURIComponent(identifier)}.json`);

  if (!forceRefresh && fs.existsSync(cacheFile)) {
    const stats = fs.statSync(cacheFile);
    const now = new Date();
    const mtime = new Date(stats.mtime);
    
    // Check if cache is from today
    const isSameDay = now.getFullYear() === mtime.getFullYear() &&
                      now.getMonth() === mtime.getMonth() &&
                      now.getDate() === mtime.getDate();
                      
    if (isSameDay) {
      const cachedData = fs.readFileSync(cacheFile, 'utf8');
      return res.json(JSON.parse(cachedData));
    }
  }

  const youtube = getYouTubeClient();
  if (!youtube) {
    return res.status(500).json({ error: 'No YouTube API key configured' });
  }

  try {
    let channelId = identifier;
    let uploadsPlaylistId = null;
    let channelName = null;

    let channelResponse;
    if (identifier.startsWith('@')) {
      channelResponse = await youtube.channels.list({ part: 'snippet,contentDetails', forHandle: identifier });
    } else {
      channelResponse = await youtube.channels.list({ part: 'snippet,contentDetails', id: identifier });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      const searchRes = await youtube.search.list({ part: 'snippet', q: identifier, type: 'channel', maxResults: 1 });
      if (searchRes.data.items && searchRes.data.items.length > 0) {
        channelId = searchRes.data.items[0].snippet.channelId;
        const fallback = await youtube.channels.list({ part: 'snippet,contentDetails', id: channelId });
        if (fallback.data.items && fallback.data.items.length > 0) {
          uploadsPlaylistId = fallback.data.items[0].contentDetails.relatedPlaylists.uploads;
          channelName = fallback.data.items[0].snippet.title;
        }
      }
    } else {
      uploadsPlaylistId = channelResponse.data.items[0].contentDetails.relatedPlaylists.uploads;
      channelName = channelResponse.data.items[0].snippet.title;
    }

    if (!uploadsPlaylistId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    let videos = [];
    let nextPageToken = null;
    do {
      const playlistRes = await youtube.playlistItems.list({
        part: 'snippet',
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: nextPageToken,
      });
      videos = videos.concat(playlistRes.data.items.map(item => ({
        id: item.snippet.resourceId.videoId,
        title: item.snippet.title,
      })));
      nextPageToken = playlistRes.data.nextPageToken;
    } while (nextPageToken);

    const finalData = { channelName, videos };
    fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2), 'utf8');
    
    // Save to config
    fs.writeFileSync(configFile, JSON.stringify({ lastChannelId: identifier }, null, 2), 'utf8');
    
    res.json(finalData);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const inFlightAnalyze = new Map();
const ANALYZE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/analyze', async (req, res) => {
  const { keyword, channelId } = req.query;
  if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

  const normalizedKw = keyword.trim().toLowerCase();
  const cacheFile = path.join(cacheDir, `analyze_${encodeURIComponent(normalizedKw)}.json`);

  // 1. Check persistent cache
  if (fs.existsSync(cacheFile)) {
    try {
      const stats = fs.statSync(cacheFile);
      if (Date.now() - stats.mtimeMs < ANALYZE_CACHE_TTL) {
        const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return res.json(cachedData);
      }
    } catch {
      // Ignore cache read error and re-fetch
    }
  }

  // 2. In-flight request deduplication
  if (inFlightAnalyze.has(normalizedKw)) {
    try {
      const result = await inFlightAnalyze.get(normalizedKw);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // Load channel videos for rank detection if available
  let channelVideoIds = new Set();
  let targetChannelName = null;
  const activeChannelId = channelId || (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).lastChannelId : null);
  if (activeChannelId) {
    const chCacheFile = path.join(cacheDir, `${encodeURIComponent(activeChannelId)}.json`);
    if (fs.existsSync(chCacheFile)) {
      try {
        const chData = JSON.parse(fs.readFileSync(chCacheFile, 'utf8'));
        if (chData.videos) {
          chData.videos.forEach(v => {
            if (v.id) channelVideoIds.add(v.id);
          });
        }
        targetChannelName = chData.channelName ? chData.channelName.toLowerCase() : null;
      } catch {}
    }
  }

  const fetchPromise = (async () => {
    const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      }
    });
    const html = await response.text();

    const rendererBlocks = html.split('"videoRenderer":{').slice(1);
    let count = 0;
    let isUnique = true;
    let channelRank = null;
    const videos = [];

    for (let i = 0; i < Math.min(rendererBlocks.length, 30); i++) {
      const block = rendererBlocks[i];
      const videoIdMatch = block.match(/^"videoId":"(.*?)"/);
      if (!videoIdMatch) continue;
      const videoId = videoIdMatch[1];

      const titleMatch = block.match(/"title":\{"runs":\[\{"text":"(.*?)"\}/);
      const title = titleMatch
        ? titleMatch[1].replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
        : '';

      const viewMatch = block.match(/"viewCountText":\{"simpleText":"(.*?)"\}/);
      const views = viewMatch ? viewMatch[1] : '';

      const ownerMatch = block.match(/"ownerText":\{"runs":\[\{"text":"(.*?)"/);
      const ownerName = ownerMatch
        ? ownerMatch[1].replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16))).toLowerCase()
        : '';

      const browseMatch = block.match(/"browseId":"(UC[\w-]+)"/);
      const browseId = browseMatch ? browseMatch[1] : '';

      if (title.toLowerCase() === normalizedKw) {
        isUnique = false;
      }

      // Accurate check if this search result belongs to the user's synced channel
      const isUserVideo = channelVideoIds.has(videoId) ||
        (browseId && activeChannelId && browseId === activeChannelId) ||
        (targetChannelName && ownerName && (ownerName === targetChannelName || ownerName === targetChannelName.replace('@', '')));

      if (!channelRank && isUserVideo) {
        channelRank = {
          position: count + 1,
          videoId,
          title
        };
      }

      if (videos.length < 5 && !videos.some(v => v.videoId === videoId)) {
        videos.push({ videoId, title, views, subs: 'N/A' });
      }

      count++;
      if (count >= 25) break;
    }

    // Attempt to get subscriber counts via YouTube API
    const youtube = getYouTubeClient();
    if (youtube && videos.length > 0) {
      try {
        const videoIds = videos.map(v => v.videoId).join(',');
        const vRes = await youtube.videos.list({ part: 'snippet', id: videoIds });

        const channelIds = vRes.data.items.map(item => item.snippet.channelId);
        if (channelIds.length > 0) {
          const uniqueChannelIds = [...new Set(channelIds)];
          const cRes = await youtube.channels.list({ part: 'statistics', id: uniqueChannelIds.join(',') });

          const channelMap = {};
          cRes.data.items.forEach(c => {
            let subs = c.statistics.subscriberCount;
            if (subs) {
              const num = parseInt(subs, 10);
              if (num >= 1000000) subs = (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
              else if (num >= 1000) subs = (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
              channelMap[c.id] = subs;
            }
          });

          // Map back to videos
          vRes.data.items.forEach(item => {
            const vIndex = videos.findIndex(v => v.videoId === item.id);
            if (vIndex !== -1 && channelMap[item.snippet.channelId]) {
              videos[vIndex].subs = channelMap[item.snippet.channelId];
            }
          });
        }
      } catch (apiErr) {
        console.error('YouTube API quota exceeded or error fetching subs:', apiErr.message);
      }
    }

    const finalData = { isUnique, videos, channelRank };
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2), 'utf8');
    } catch {}
    return finalData;
  })();

  inFlightAnalyze.set(normalizedKw, fetchPromise);

  try {
    const data = await fetchPromise;
    res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Request aborted for:', keyword);
      return;
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    inFlightAnalyze.delete(normalizedKw);
  }
});

app.get('/api/action-words', async (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.status(400).json({ error: 'Missing topic' });
  
  const cacheFile = path.join(cacheDir, `actions_${encodeURIComponent(topic)}.json`);
  if (fs.existsSync(cacheFile)) {
    return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  }
  
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
  
  const commonVerbs = [
    'add', 'create', 'delete', 'remove', 'update', 'edit', 'change', 'cancel', 'stop', 'pause', 
    'run', 'start', 'activate', 'deactivate', 'disable', 'enable', 'connect', 'disconnect', 
    'link', 'unlink', 'pay', 'buy', 'sell', 'setup', 'set up', 'install', 'uninstall', 
    'download', 'upload', 'export', 'import', 'share', 'hide', 'unhide', 'view', 'see', 
    'find', 'search', 'recover', 'restore', 'reset', 'clear', 'block', 'unblock', 'report', 
    'appeal', 'verify', 'authenticate', 'login', 'logout', 'sign in', 'sign out', 'sign up', 
    'register', 'upgrade', 'downgrade', 'switch', 'transfer', 'move', 'copy', 'paste', 
    'duplicate', 'merge', 'split', 'join', 'leave', 'invite', 'accept', 'reject', 'decline', 
    'allow', 'deny', 'grant', 'revoke', 'manage', 'optimize', 'boost', 'increase', 'decrease', 
    'scale', 'grow', 'measure', 'track', 'monitor', 'analyze', 'test', 'fix', 'repair', 
    'troubleshoot', 'resolve', 'solve', 'debug', 'bypass', 'skip', 'hack', 'cheat', 'trick', 
    'get', 'use', 'learn', 'master', 'understand', 'read', 'write', 'send', 'receive', 
    'forward', 'reply', 'schedule', 'automate', 'sync', 'synchronize', 'backup', 'back up', 
    'print', 'save', 'publish', 'unpublish', 'draft', 'archive', 'unarchive', 'pin', 'unpin', 
    'feature', 'promote', 'demote', 'bid', 'budget', 'spend', 'earn', 'monotize', 'monetize', 
    'withdraw', 'deposit', 'refund', 'charge', 'bill', 'invoice', 'close', 'open', 'lock', 
    'unlock', 'protect', 'secure', 'subscribe', 'unsubscribe', 'follow', 'unfollow', 'like', 
    'dislike', 'comment', 'contact', 'call', 'email', 'chat', 'message'
  ];

  try {
    const queries = [];
    
    // 1. A-Z Queries (Both prefixes and postfixes)
    alphabet.forEach(letter => {
      queries.push(`how to ${letter} ${topic}`);
      queries.push(`how to ${topic} ${letter}`);
    });
    
    // 2. Common Verbs Queries
    commonVerbs.forEach(verb => {
      queries.push(`how to ${verb} ${topic}`);
    });

    const promises = queries.map(q => {
      const url = `https://suggestqueries.google.com/complete/search?client=chrome&ds=yt&q=${encodeURIComponent(q)}`;
      return fetch(url).then(r => r.json()).catch(() => null);
    });

    // Fire all queries concurrently
    const results = await Promise.all(promises);
    
    const actionWords = new Set();
    const cleanPrefix = "how to ";
    
    results.forEach((resData) => {
      if (resData && resData[1]) {
        resData[1].forEach(suggestion => {
          const sugLower = suggestion.toLowerCase();
          
          if (sugLower.startsWith(cleanPrefix)) {
            const remainder = sugLower.slice(cleanPrefix.length).trim();
            
            // Case 1: action word is before the topic (e.g. how to delete google ads)
            if (remainder.includes(topic)) {
              const beforeTopic = remainder.split(topic)[0].trim();
              if (beforeTopic) {
                const words = beforeTopic.split(/\s+/);
                const firstWord = words[0];
                if (firstWord && /^[a-z]+$/.test(firstWord) && firstWord.length >= 2) {
                  actionWords.add(firstWord);
                }
              }
            }
            
            // Case 2: action word is after the topic (e.g. how to google ads delete)
            if (remainder.startsWith(topic)) {
              const afterTopic = remainder.slice(topic.length).trim();
              if (afterTopic) {
                const words = afterTopic.split(/\s+/);
                const firstWord = words[0];
                if (firstWord && /^[a-z]+$/.test(firstWord) && firstWord.length >= 2) {
                  actionWords.add(firstWord);
                }
              }
            }
          }
        });
      }
    });

    const finalWords = Array.from(actionWords).sort();
    const dataToSave = { actionWords: finalWords };
    fs.writeFileSync(cacheFile, JSON.stringify(dataToSave), 'utf8');
    
    res.json(dataToSave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



const PORT = 3001;
app.listen(PORT, () => console.log(`Backend server running on http://localhost:${PORT}`));
