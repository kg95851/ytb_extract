// 독립 페이지: 채널 전체 대본 추출기
// - YouTube Data API 키 회전
// - Transcript 서버 호출(/transcript) — 서버가 Webshare 등 프록시 구성 시 IP 회전
// - Supabase 등 DB 연동 없음. 결과는 메모리에 유지 후 JSON 내보내기

// DOM
const chInput = document.getElementById('ch-input');
const videoInput = document.getElementById('video-input');
const channelInputWrap = document.getElementById('channel-input-wrap');
const videoInputWrap = document.getElementById('video-input-wrap');
const modeChannelBtn = document.getElementById('mode-channel');
const modeVideoBtn = document.getElementById('mode-video');
const srvInput = document.getElementById('srv-input');
const keysInput = document.getElementById('keys-input');
const saveKeysBtn = document.getElementById('save-keys');
const testKeyBtn = document.getElementById('test-key');
const keysStatus = document.getElementById('keys-status');
const maxVideosInput = document.getElementById('max-videos');
const concInput = document.getElementById('conc-input');
const sttInput = document.getElementById('stt-input');
const minViewsInput = document.getElementById('min-views');
const maxCommentsInput = document.getElementById('max-comments');
const dateRangeInput = document.getElementById('date-range');
const btnResolve = document.getElementById('resolve-ch');
const btnList = document.getElementById('list-videos');
const btnLoadVideoUrls = document.getElementById('load-video-urls');
const btnStart = document.getElementById('start');
const btnStop = document.getElementById('stop');
const btnExport = document.getElementById('export');
const btnExportPdf = document.getElementById('export-pdf');
const btnExportPdfSplit = document.getElementById('export-pdf-split');
const statusLine = document.getElementById('status-line');
const subStatus = document.getElementById('sub-status');
const countsLine = document.getElementById('counts-line');
const progressBar = document.getElementById('progress-bar');
const logEl = document.getElementById('log');
const settingsPanel = document.getElementById('settings-panel');
const toggleSettingsBtn = document.getElementById('toggle-settings');
const closeSettingsBtn = document.getElementById('close-settings');

// State
let ALL_KEYS = [];
let KEY_INDEX = 0;
let VIDEOS = []; // { id, title, publishedAt, url, views }
let RESULTS = []; // { id, title, publishedAt, transcript, comments, error }
let ABORT = false;
let RESOLVED_CHANNEL = null; // { id, title }
let RESOLVED_CHANNELS = []; // [{ id, title }]
let STARTED_AT = 0;
let SUCC = 0;
let FAIL = 0;
let SELECTED_AFTER = '';
let SELECTED_BEFORE = '';
let CURRENT_MODE = 'channel'; // 'channel' or 'video'

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s || ''));
  } catch {
    return String(s || '');
  }
}

function fmtYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function log(line) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg, sub='') {
  statusLine.textContent = msg;
  subStatus.textContent = sub || '';
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  countsLine.textContent = `${done} / ${total}`;
}

function fmtTime(ms) {
  if (!ms || ms <= 0) return '';
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (s > 0 && parts.length === 0) parts.push(`${s}초`);
  return parts.join(' ');
}

function updateSubStatus(processed, total) {
  const now = Date.now();
  const elapsed = STARTED_AT ? (now - STARTED_AT) : 0;
  const rate = processed > 0 ? (processed / Math.max(1, elapsed / 1000)) : 0; // items/sec
  const remain = Math.max(0, total - processed);
  const etaMs = rate > 0 ? Math.round((remain / rate) * 1000) : 0;
  const eta = fmtTime(etaMs);
  const elapsedStr = fmtTime(elapsed);
  const etaText = eta ? `, 예상 ${eta} 남음` : '';
  subStatus.textContent = `성공 ${SUCC}, 실패 ${FAIL}, 경과 ${elapsedStr}${etaText}`;
}

function getKeysFromTextarea() {
  return (keysInput.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function getChannelsFromTextarea() {
  const raw = String(chInput.value || '');
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines;
}

function getServerBase() {
  const v = (srvInput.value || '').trim();
  return v || '/api';
}

function rotateKey() {
  if (!ALL_KEYS.length) return '';
  const key = ALL_KEYS[KEY_INDEX % ALL_KEYS.length];
  KEY_INDEX++;
  return key;
}

function parseChannelInput(raw) {
  const rawStr = String(raw || '').trim();
  const s = safeDecode(rawStr);
  if (!s) return { type: 'unknown', value: '' };
  // direct channel id
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return { type: 'channelId', value: s };
  // @handle
  if (s.startsWith('@')) return { type: 'handle', value: safeDecode(s.replace(/^@/, '')) };
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      // /channel/UCxxxx
      const m = u.pathname.match(/\/channel\/(UC[0-9A-Za-z_-]+)/i);
      if (m) return { type: 'channelId', value: m[1] };
      // /@handle
      const m2 = u.pathname.match(/\/@([^\/]+)/);
      if (m2) return { type: 'handle', value: safeDecode(m2[1]) };
      // /user/xxx 또는 /c/xxx -> 검색 사용으로 해석
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'user' || parts[0] === 'c') {
        return { type: 'custom', value: safeDecode(parts[1] || '') };
      }
    }
  } catch {}
  // 문자열 전체를 검색 쿼리로 사용
  return { type: 'search', value: s };
}

// 영상 URL에서 video ID 추출
function parseVideoUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  
  // 직접 video ID (11자)
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  
  try {
    const u = new URL(s);
    // youtube.com/watch?v=xxx
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/xxx
      const shortsMatch = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
      // /embed/xxx
      const embedMatch = u.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];
      // /v/xxx
      const vMatch = u.pathname.match(/\/v\/([A-Za-z0-9_-]{11})/);
      if (vMatch) return vMatch[1];
    }
    // youtu.be/xxx
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
  } catch {}
  
  return null;
}

// 영상 URL 텍스트에서 모든 video ID 추출
function getVideoUrlsFromTextarea() {
  const raw = String(videoInput?.value || '');
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const ids = [];
  for (const line of lines) {
    const id = parseVideoUrl(line);
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

// 영상 정보 가져오기 (API)
async function fetchVideoInfo(keys, videoIds) {
  const results = [];
  
  for (let i = 0; i < videoIds.length; i += 50) {
    if (ABORT) break;
    const batch = videoIds.slice(i, i + 50);
    const key = rotateKey();
    const url = buildUrl('https://www.googleapis.com/youtube/v3/videos', {
      part: 'snippet,statistics',
      id: batch.join(','),
      key
    });
    
    try {
      const j = await ytFetch(url);
      const items = Array.isArray(j.items) ? j.items : [];
      for (const it of items) {
        results.push({
          id: it.id,
          title: it.snippet?.title || '',
          publishedAt: it.snippet?.publishedAt || '',
          url: `https://www.youtube.com/watch?v=${it.id}`,
          views: Number(it.statistics?.viewCount || 0),
          channelId: it.snippet?.channelId || '',
          channelTitle: it.snippet?.channelTitle || ''
        });
      }
    } catch (e) {
      log(`[video] 영상 정보 조회 오류: ${e?.message || e}`);
    }
    
    if (i + 50 < videoIds.length) {
      await new Promise(r => setTimeout(r, 120 + Math.random()*120));
    }
  }
  
  return results;
}

// 모드 전환 함수
function setMode(mode) {
  CURRENT_MODE = mode;
  
  if (mode === 'channel') {
    channelInputWrap.style.display = '';
    videoInputWrap.style.display = 'none';
    modeChannelBtn.classList.add('btn-primary');
    modeVideoBtn.classList.remove('btn-primary');
    btnResolve.style.display = '';
    btnList.style.display = '';
    btnLoadVideoUrls.style.display = 'none';
  } else {
    channelInputWrap.style.display = 'none';
    videoInputWrap.style.display = '';
    modeChannelBtn.classList.remove('btn-primary');
    modeVideoBtn.classList.add('btn-primary');
    btnResolve.style.display = 'none';
    btnList.style.display = 'none';
    btnLoadVideoUrls.style.display = '';
  }
  
  log(`[mode] ${mode === 'channel' ? '채널' : '영상 URL'} 모드로 전환`);
}

async function ytFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('yt api http ' + res.status);
  return await res.json();
}

function buildUrl(base, params) {
  const u = new URL(base);
  Object.entries(params || {}).forEach(([k,v]) => {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  });
  return u.toString();
}

async function resolveChannel(keys, inputRaw) {
  const parsed = parseChannelInput(inputRaw);
  if (!parsed.value) throw new Error('채널 입력을 확인하세요.');
  // 1) channelId 인 경우 바로 확인
  if (parsed.type === 'channelId') {
    const key = rotateKey();
    const url = buildUrl('https://www.googleapis.com/youtube/v3/channels', {
      part: 'snippet',
      id: parsed.value,
      key
    });
    const j = await ytFetch(url);
    const item = (j.items || [])[0];
    if (!item) throw new Error('채널을 찾을 수 없습니다.');
    return { id: parsed.value, title: item.snippet?.title || '' };
  }
  // 2) @handle, custom, search 는 search API로 채널 먼저 찾기
  const variants = [];
  if (parsed.type === 'handle') {
    variants.push('@' + parsed.value);
    variants.push(parsed.value);
  } else {
    variants.push(parsed.value);
  }
  let pageToken = '';
  for (const query of variants) {
    pageToken = '';
    for (let tries = 0; tries < 8; tries++) {
      const key = rotateKey();
      const url = buildUrl('https://www.googleapis.com/youtube/v3/search', {
        part: 'snippet',
        q: query,
        type: 'channel',
        maxResults: 5,
        key,
        pageToken
      });
      try {
        const j = await ytFetch(url);
        const item = (j.items || [])[0];
        if (item && item.snippet) {
          return { id: item.id?.channelId, title: item.snippet.title || '' };
        }
        pageToken = j.nextPageToken || '';
        if (!pageToken) break;
      } catch (e) {
        // 쿼터/429 시 짧은 대기 후 재시도
        await new Promise(r => setTimeout(r, 500 + Math.random()*500));
        continue;
      }
    }
  }
  throw new Error('채널 해석 실패');
}

async function resolveMultipleChannels(keys, inputs) {
  const targets = Array.isArray(inputs) && inputs.length ? inputs : getChannelsFromTextarea();
  if (!targets.length) throw new Error('채널 입력을 확인하세요.');
  const resolved = [];
  for (const one of targets) {
    try {
      const info = await resolveChannel(keys, one);
      resolved.push(info);
      log(`[resolve] 채널: ${info.title} (${info.id})`);
    } catch (e) {
      log(`[resolve] 실패: ${one} — ${e?.message || e}`);
    }
    await new Promise(r => setTimeout(r, 200 + Math.random()*200));
  }
  if (!resolved.length) throw new Error('채널 해석 실패');
  return resolved;
}

async function listChannelVideos(keys, channelId, { maxCount, publishedAfter, publishedBefore, minViews } = {}) {
  const all = [];
  let pageToken = '';
  
  // 날짜 처리 개선 - 한국 시간 기준으로 정확하게 변환
  let afterISO, beforeISO;
  if (publishedAfter) {
    // 시작일 00:00:00 KST
    const afterDate = new Date(publishedAfter + 'T00:00:00+09:00');
    afterISO = afterDate.toISOString();
    log(`[list] 시작일: ${publishedAfter} → ${afterISO}`);
  }
  if (publishedBefore) {
    // 종료일 23:59:59 KST (포함하기 위해 다음날로 설정)
    const beforeDate = new Date(publishedBefore + 'T23:59:59+09:00');
    beforeDate.setSeconds(beforeDate.getSeconds() + 1); // 다음날 00:00:00으로
    beforeISO = beforeDate.toISOString();
    log(`[list] 종료일: ${publishedBefore} → ${beforeISO}`);
  }
  
  let totalFetched = 0;
  let pageNum = 0;
  
  while (true) {
    if (ABORT) break;
    const key = rotateKey();
    const url = buildUrl('https://www.googleapis.com/youtube/v3/search', {
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: 50,
      key,
      pageToken,
      publishedAfter: afterISO,
      publishedBefore: beforeISO
    });
    
    log(`[list] API 호출 ${++pageNum}페이지, pageToken: ${pageToken || 'none'}`);
    try {
      const j = await ytFetch(url);
      const items = Array.isArray(j.items) ? j.items : [];
      totalFetched += items.length;
      
      log(`[list] ${items.length}개 가져옴 (누적: ${totalFetched}개)`);
      
      for (const it of items) {
        const id = it.id?.videoId;
        if (!id) continue;
        
        const videoData = {
          id,
          title: it.snippet?.title || '',
          publishedAt: it.snippet?.publishedAt || '',
          url: `https://www.youtube.com/watch?v=${id}`
        };
        
        // 날짜 로그 (디버깅용)
        const pubDate = new Date(videoData.publishedAt);
        if (totalFetched <= 5 || (totalFetched % 10 === 0)) {
          log(`[list] ${videoData.title} - ${pubDate.toLocaleDateString('ko-KR')}`);
        }
        
        all.push(videoData);
        if (maxCount && all.length >= maxCount) break;
      }
      
      if (maxCount && all.length >= maxCount) {
        log(`[list] 최대 개수 도달 (${maxCount}개)`);
        break;
      }
      
      pageToken = j.nextPageToken || '';
      if (!pageToken) {
        log(`[list] 더 이상 페이지 없음`);
        break;
      }
      
      log(`[list] 다음 페이지 토큰: ${pageToken.substring(0, 10)}...`);
      
      // QPS 완화
      await new Promise(r => setTimeout(r, 120 + Math.random()*120));
    } catch (e) {
      log(`[list] 오류: ${e?.message || e} — 키 교체/대기`);
      await new Promise(r => setTimeout(r, 800 + Math.random()*600));
      continue;
    }
  }
  log(`[list] 총 ${all.length}개 영상 수집됨`);
  
  // 조회수 조회
  if (all.length > 0) {
    log(`[list] 조회수 정보 가져오는 중...`);
    try {
      const ids = all.map(v => v.id);
      let viewsFetched = 0;
      
      for (let i = 0; i < ids.length; i += 50) {
        if (ABORT) break;
        const batch = ids.slice(i, i + 50);
        const key = rotateKey();
        const vurl = buildUrl('https://www.googleapis.com/youtube/v3/videos', {
          part: 'statistics',
          id: batch.join(','),
          key
        });
        try {
          const j = await ytFetch(vurl);
          const items = Array.isArray(j.items) ? j.items : [];
          const viewsMap = new Map(items.map(it => [it.id, Number(it.statistics?.viewCount || 0)]));
          for (const v of all) {
            if (viewsMap.has(v.id)) {
              v.views = viewsMap.get(v.id) || 0;
              viewsFetched++;
            }
          }
        } catch (e) {
          log(`[list] views 오류: ${e?.message || e}`);
        }
        await new Promise(r => setTimeout(r, 120 + Math.random()*120));
      }
      log(`[list] ${viewsFetched}개 영상 조회수 확인`);
    } catch (e) {
      log(`[list] 조회수 조회 실패: ${e?.message || e}`);
    }
  }
  
  // 필터 적용
  const beforeFilter = all.length;
  const filtered = minViews ? all.filter(v => {
    const pass = (v.views || 0) >= minViews;
    if (!pass && v.views !== undefined) {
      // 필터링된 영상 몇 개 로그
      if (Math.random() < 0.1) { // 10% 샘플링
        log(`[list] 필터됨: ${v.title} (${v.views?.toLocaleString()}회)`);
      }
    }
    return pass;
  }) : all;
  
  if (minViews && beforeFilter !== filtered.length) {
    log(`[list] 조회수 필터 적용: ${beforeFilter}개 → ${filtered.length}개 (최소 ${minViews.toLocaleString()}회)`);
  }
  
  return filtered;
}

// ========== 클라이언트 측 IndexedDB 캐시 ==========
const CACHE_DB_NAME = 'TranscriptCache';
const CACHE_STORE_NAME = 'transcripts';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

let _cacheDb = null;
let _cacheStats = { hits: 0, misses: 0 };

async function openCacheDb() {
  if (_cacheDb) return _cacheDb;
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, 1);
    
    request.onerror = () => {
      console.log('[cache] IndexedDB 열기 실패');
      resolve(null);
    };
    
    request.onsuccess = () => {
      _cacheDb = request.result;
      resolve(_cacheDb);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'videoId' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

async function getCachedTranscript(videoId) {
  try {
    const db = await openCacheDb();
    if (!db) return null;
    
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(videoId);
      
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          // TTL 체크
          const age = Date.now() - (result.timestamp || 0);
          if (age < CACHE_TTL_MS) {
            _cacheStats.hits++;
            resolve(result.text);
            return;
          }
        }
        _cacheStats.misses++;
        resolve(null);
      };
      
      request.onerror = () => {
        _cacheStats.misses++;
        resolve(null);
      };
    });
  } catch (e) {
    console.log('[cache] 캐시 조회 오류:', e);
    return null;
  }
}

async function setCachedTranscript(videoId, text) {
  try {
    const db = await openCacheDb();
    if (!db) return;
    
    const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(CACHE_STORE_NAME);
    
    store.put({
      videoId,
      text,
      timestamp: Date.now()
    });
  } catch (e) {
    console.log('[cache] 캐시 저장 오류:', e);
  }
}

async function clearExpiredCache() {
  try {
    const db = await openCacheDb();
    if (!db) return;
    
    const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(CACHE_STORE_NAME);
    const index = store.index('timestamp');
    const expireTime = Date.now() - CACHE_TTL_MS;
    
    const request = index.openCursor(IDBKeyRange.upperBound(expireTime));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  } catch (e) {
    console.log('[cache] 만료 캐시 정리 오류:', e);
  }
}

function getCacheStats() {
  const total = _cacheStats.hits + _cacheStats.misses;
  const hitRate = total > 0 ? (_cacheStats.hits / total * 100).toFixed(1) : 0;
  return {
    hits: _cacheStats.hits,
    misses: _cacheStats.misses,
    total,
    hitRate: `${hitRate}%`
  };
}

// 페이지 로드 시 만료된 캐시 정리
setTimeout(() => clearExpiredCache(), 5000);

// ========== 댓글 및 대본 가져오기 ==========

async function fetchComments(keys, videoId, maxCount = 10) {
  if (!maxCount || maxCount <= 0) return [];
  
  try {
    const key = rotateKey();
    const url = buildUrl('https://www.googleapis.com/youtube/v3/commentThreads', {
      part: 'snippet',
      videoId,
      maxResults: Math.min(100, maxCount * 2), // 좋아요 순으로 정렬하기 위해 더 많이 가져옴
      order: 'relevance', // 관련성 높은 댓글 (좋아요 많은 것들 포함)
      key
    });
    
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[comments] 댓글 조회 실패: ${videoId} - HTTP ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const comments = (data.items || []).map(item => {
      const topComment = item.snippet?.topLevelComment?.snippet;
      return {
        author: topComment?.authorDisplayName || '',
        text: topComment?.textDisplay || topComment?.textOriginal || '',
        likes: topComment?.likeCount || 0,
        publishedAt: topComment?.publishedAt || ''
      };
    });
    
    // 좋아요 순으로 정렬하고 상위 N개만 선택
    comments.sort((a, b) => b.likes - a.likes);
    return comments.slice(0, maxCount);
  } catch (e) {
    console.log(`[comments] 오류: ${videoId} - ${e?.message || e}`);
    return [];
  }
}

// 영상 ID 추출 헬퍼
function extractVideoId(youtubeUrl) {
  try {
    if (youtubeUrl.includes('watch?v=')) {
      return youtubeUrl.split('watch?v=')[1].split('&')[0];
    } else if (youtubeUrl.includes('youtu.be/')) {
      return youtubeUrl.split('youtu.be/')[1].split('?')[0];
    } else if (youtubeUrl.includes('/shorts/')) {
      return youtubeUrl.split('/shorts/')[1].split('?')[0];
    }
  } catch {}
  return youtubeUrl;
}

async function fetchTranscriptByUrl(serverBase, youtubeUrl, useStt) {
  const videoId = extractVideoId(youtubeUrl);
  
  // 1. 클라이언트 캐시 확인
  const cached = await getCachedTranscript(videoId);
  if (cached) {
    console.log(`[cache] 캐시 히트: ${videoId}`);
    return cached;
  }
  
  // 2. 서버에서 가져오기
  const url = serverBase.replace(/\/$/, '') + '/transcript?url=' + encodeURIComponent(youtubeUrl) + '&lang=ko,en' + (useStt ? '&stt=1' : '');
  
  // 타임아웃 설정 (30초)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = j && j.error ? String(j.error) : ''; } catch {}
      throw new Error('Transcript http ' + res.status + (reason ? (' ' + reason) : ''));
    }
    const data = await res.json();
    const text = data.text || '';
    
    // 3. 성공 시 클라이언트 캐시에 저장
    if (text) {
      await setCachedTranscript(videoId, text);
      if (data.cached) {
        console.log(`[cache] 서버 캐시 히트: ${videoId}`);
      } else {
        console.log(`[cache] 새로 추출: ${videoId}`);
      }
    }
    
    return text;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('요청 타임아웃 (30초 초과)');
    }
    throw e;
  }
}

async function processInBatches(items, worker, { concurrency = 8, onProgress } = {}) {
  return await new Promise((resolve) => {
    // 빈 배열 처리
    if (!items || items.length === 0) {
      console.log('[batch] 처리할 항목 없음');
      return resolve({ done: 0, failed: 0 });
    }
    
    let i = 0, inFlight = 0, done = 0, failed = 0;
    const total = items.length;
    let isResolved = false;
    
    // 디버깅용 로그와 완료 체크
    const checkCompletion = () => {
      if (isResolved) return;
      
      const processed = done + failed;
      console.log(`[batch] 진행상황: ${processed}/${total}, inFlight: ${inFlight}, done: ${done}, failed: ${failed}`);
      
      if (ABORT) {
        console.log('[batch] 중단됨');
        isResolved = true;
        return resolve({ done, failed, aborted: true });
      }
      
      // 모든 작업이 완료되었는지 확인 (처리된 수가 total과 같고 진행중인 작업이 없을 때)
      if (processed >= total && inFlight === 0) {
        console.log('[batch] 모든 작업 완료!');
        isResolved = true;
        return resolve({ done, failed });
      }
      
      // 마지막 항목까지 시작했고 진행중인 작업이 없는 경우 (예외 상황)
      if (i >= total && inFlight === 0 && !isResolved) {
        console.log('[batch] 완료 (예외 케이스)');
        isResolved = true;
        return resolve({ done, failed });
      }
    };
    
    const pump = () => {
      // pump 시작 시 항상 완료 체크
      checkCompletion();
      if (isResolved) return;
      
      while (inFlight < concurrency && i < total && !ABORT) {
        const idx = i++;
        const item = items[idx];
        const itemId = item.id || idx;
        
        console.log(`[batch] 시작: ${itemId} (${idx + 1}/${total})`);
        inFlight++;
        
        // 타임아웃 ID를 저장하여 성공 시 취소 가능
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('작업 타임아웃 (60초)')), 60000);
        });
        
        Promise.race([worker(item), timeoutPromise])
          .then(() => {
            clearTimeout(timeoutId);
            done++;
            console.log(`[batch] 성공: ${itemId} (완료: ${done}/${total})`);
          })
          .catch((e) => {
            clearTimeout(timeoutId);
            failed++;
            console.log(`[batch] 실패: ${itemId} - ${e?.message || e} (실패: ${failed})`);
          })
          .finally(() => {
            inFlight--;
            console.log(`[batch] 작업 종료: ${itemId}, 남은 진행중: ${inFlight}`);
            
            if (typeof onProgress === 'function') {
              try { onProgress({ processed: done + failed, total }); } catch {}
            }
            
            // 작업 완료 후 항상 완료 체크
            checkCompletion();
            
            // 아직 처리할 작업이 있거나 진행중인 작업이 있으면 pump 호출
            if (!isResolved && (i < total || inFlight > 0)) {
              pump();
            }
          });
      }
      
      // 모든 작업이 시작된 후에도 한 번 더 완료 체크
      if (i >= total && !isResolved) {
        console.log('[batch] 모든 작업 시작됨, 대기중...');
        checkCompletion();
      }
    };
    
    // 초기 실행
    pump();
  });
}

function exportJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function saveLocal() {
  try {
    localStorage.setItem('ce_keys', keysInput.value || '');
    localStorage.setItem('ce_server', srvInput.value || '');
    localStorage.setItem('ce_conc', concInput.value || '8');
    localStorage.setItem('ce_stt', sttInput.value || '0');
  } catch {}
}

function loadLocal() {
  try {
    const k = localStorage.getItem('ce_keys') || '';
    const s = localStorage.getItem('ce_server') || '';
    const c = localStorage.getItem('ce_conc') || '8';
    const stt = localStorage.getItem('ce_stt') || '0';
    if (k) keysInput.value = k;
    if (s) srvInput.value = s;
    if (c) concInput.value = c;
    if (stt) sttInput.value = stt;
  } catch {}
}

// 설정 패널 토글
function toggleSettings(show) {
  if (settingsPanel) {
    settingsPanel.style.display = show ? '' : 'none';
  }
}

// Events
toggleSettingsBtn?.addEventListener('click', () => {
  const isHidden = settingsPanel.style.display === 'none';
  toggleSettings(isHidden);
});

closeSettingsBtn?.addEventListener('click', () => {
  toggleSettings(false);
});

saveKeysBtn?.addEventListener('click', () => {
  saveLocal();
  keysStatus.textContent = '저장되었습니다.';
  setTimeout(() => { keysStatus.textContent = ''; }, 1500);
});

testKeyBtn?.addEventListener('click', async () => {
  try {
    const keys = getKeysFromTextarea();
    if (!keys.length) { keysStatus.textContent = '키를 입력하세요.'; return; }
    keysStatus.textContent = '테스트 중...';
    const url = 'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=dQw4w9WgXcQ&key=' + encodeURIComponent(keys[0]);
    const res = await fetch(url);
    keysStatus.textContent = res.ok ? '키 통신 성공' : 'HTTP ' + res.status;
  } catch (e) {
    keysStatus.textContent = '테스트 실패: ' + (e?.message || e);
  }
});

btnResolve?.addEventListener('click', async () => {
  try {
    setStatus('채널 확인 중...');
    log('[resolve] 채널 확인 시작');
    ALL_KEYS = getKeysFromTextarea();
    if (!ALL_KEYS.length) throw new Error('YouTube API 키가 필요합니다.');
    KEY_INDEX = 0;
    RESOLVED_CHANNELS = await resolveMultipleChannels(ALL_KEYS);
    RESOLVED_CHANNEL = RESOLVED_CHANNELS[0] || null;
    setStatus('채널 확인 완료', `${RESOLVED_CHANNELS.length}개 채널`);
    log(`[resolve] 총 ${RESOLVED_CHANNELS.length}개 채널 확인`);
  } catch (e) {
    setStatus('채널 확인 실패', e?.message || String(e));
    log('[resolve] 실패: ' + (e?.message || e));
  }
});

btnList?.addEventListener('click', async () => {
  try {
    setStatus('영상 목록 불러오는 중...');
    log('[list] 시작');
    ABORT = false;
    ALL_KEYS = getKeysFromTextarea();
    if (!ALL_KEYS.length) throw new Error('YouTube API 키가 필요합니다.');
    KEY_INDEX = 0;
    if (!RESOLVED_CHANNELS || RESOLVED_CHANNELS.length === 0) {
      RESOLVED_CHANNELS = await resolveMultipleChannels(ALL_KEYS);
      RESOLVED_CHANNEL = RESOLVED_CHANNELS[0] || null;
    }
    const maxCount = Math.max(0, Number(maxVideosInput.value || 0)) || undefined;
    const after = (SELECTED_AFTER || '').trim() || undefined;
    const before = (SELECTED_BEFORE || '').trim() || undefined;
    const minViews = Math.max(0, Number(minViewsInput?.value || 0)) || undefined;
    VIDEOS = [];
    for (const ch of RESOLVED_CHANNELS) {
      const vids = await listChannelVideos(ALL_KEYS, ch.id, { maxCount, publishedAfter: after, publishedBefore: before, minViews });
      for (const v of vids) {
        v.channelId = ch.id;
        v.channelTitle = ch.title;
      }
      VIDEOS.push(...vids);
      log(`[list] ${ch.title} (${ch.id}) — ${vids.length}개`);
      await new Promise(r => setTimeout(r, 200 + Math.random()*200));
    }
    setStatus('영상 목록 완료', `총 ${VIDEOS.length}개 / 채널 ${RESOLVED_CHANNELS.length}개${minViews ? ' (필터 적용)' : ''}`);
    setProgress(0, VIDEOS.length);
    log(`[list] 영상 총 ${VIDEOS.length}개${minViews ? ` (최소 조회수 ${minViews} 이상)` : ''}`);
  } catch (e) {
    setStatus('영상 목록 실패', e?.message || String(e));
    log('[list] 실패: ' + (e?.message || e));
  }
});

// 영상 URL 불러오기 버튼
btnLoadVideoUrls?.addEventListener('click', async () => {
  try {
    setStatus('영상 URL 불러오는 중...');
    log('[video-url] 시작');
    ABORT = false;
    
    const videoIds = getVideoUrlsFromTextarea();
    if (!videoIds.length) throw new Error('영상 URL을 입력하세요.');
    
    log(`[video-url] ${videoIds.length}개 영상 ID 파싱됨`);
    
    ALL_KEYS = getKeysFromTextarea();
    KEY_INDEX = 0;
    
    // API 키가 있으면 영상 정보 조회, 없으면 기본 정보만
    if (ALL_KEYS.length > 0) {
      log('[video-url] API로 영상 정보 조회 중...');
      VIDEOS = await fetchVideoInfo(ALL_KEYS, videoIds);
      
      // API에서 못 가져온 영상은 기본 정보로 추가
      for (const id of videoIds) {
        if (!VIDEOS.find(v => v.id === id)) {
          VIDEOS.push({
            id,
            title: `영상 ${id}`,
            publishedAt: '',
            url: `https://www.youtube.com/watch?v=${id}`,
            views: 0,
            channelId: '',
            channelTitle: ''
          });
          log(`[video-url] ${id} - API 조회 실패, 기본 정보 사용`);
        }
      }
    } else {
      // API 키 없이 기본 정보만
      log('[video-url] API 키 없음 - 기본 정보만 사용');
      VIDEOS = videoIds.map(id => ({
        id,
        title: `영상 ${id}`,
        publishedAt: '',
        url: `https://www.youtube.com/watch?v=${id}`,
        views: 0,
        channelId: '',
        channelTitle: ''
      }));
    }
    
    // 채널 정보 수집 (PDF 내보내기용)
    const channelMap = new Map();
    for (const v of VIDEOS) {
      if (v.channelId && !channelMap.has(v.channelId)) {
        channelMap.set(v.channelId, { id: v.channelId, title: v.channelTitle });
      }
    }
    RESOLVED_CHANNELS = Array.from(channelMap.values());
    RESOLVED_CHANNEL = RESOLVED_CHANNELS[0] || null;
    
    setStatus('영상 목록 완료', `총 ${VIDEOS.length}개 영상`);
    setProgress(0, VIDEOS.length);
    
    for (const v of VIDEOS) {
      log(`[video-url] ${v.title} (${v.id})${v.channelTitle ? ' [' + v.channelTitle + ']' : ''}`);
    }
    
    log(`[video-url] 총 ${VIDEOS.length}개 영상 준비 완료`);
  } catch (e) {
    setStatus('영상 URL 불러오기 실패', e?.message || String(e));
    log('[video-url] 실패: ' + (e?.message || e));
  }
});

// 모드 전환 버튼 이벤트
modeChannelBtn?.addEventListener('click', () => setMode('channel'));
modeVideoBtn?.addEventListener('click', () => setMode('video'));

btnStart?.addEventListener('click', async () => {
  try {
    if (!VIDEOS.length) {
      // 편의: 목록이 없으면 모드에 따라 자동으로 불러오기
      if (CURRENT_MODE === 'video') {
        await btnLoadVideoUrls?.click();
      } else {
        await btnList?.click();
      }
      if (!VIDEOS.length) return;
    }
    ABORT = false;
    RESULTS = [];
    SUCC = 0; FAIL = 0;
    STARTED_AT = Date.now();
    btnStart.disabled = true; btnStop.disabled = false;
    const server = getServerBase();
    const useStt = String(sttInput.value || '0') === '1';
    const maxComments = Math.max(0, Number(maxCommentsInput?.value || 0));
    const conc = Math.max(1, Math.min(20, Number(concInput.value || 8)));
    setStatus('대본 추출 진행 중...', `${conc} 동시`);
    setProgress(0, VIDEOS.length);
    log(`[run] ${VIDEOS.length}개, 동시성 ${conc}, STT=${useStt?'on':'off'}, 댓글=${maxComments||0}개`);

    const worker = async (v) => {
      if (ABORT) throw new Error('abort');
      const startTime = Date.now();
      try {
        log(`[처리 시작] ${v.id} - ${v.title}`);
        
        // 대본과 댓글을 병렬로 가져오기
        const [text, comments] = await Promise.all([
          fetchTranscriptByUrl(server, v.url, useStt),
          maxComments > 0 ? fetchComments(ALL_KEYS, v.id, maxComments) : Promise.resolve([])
        ]);
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        RESULTS.push({ 
          id: v.id, 
          title: v.title, 
          publishedAt: v.publishedAt, 
          transcript: text,
          comments: comments,
          channelId: v.channelId, 
          channelTitle: v.channelTitle 
        });
        SUCC++;
        log(`[ok] ${v.id} (${(text||'').length} chars, ${comments.length} comments, ${elapsed}초)${v.channelTitle ? ' [' + v.channelTitle + ']' : ''}`);
      } catch (e) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        RESULTS.push({ 
          id: v.id, 
          title: v.title, 
          publishedAt: v.publishedAt, 
          error: (e?.message || String(e)), 
          comments: [],
          channelId: v.channelId, 
          channelTitle: v.channelTitle 
        });
        FAIL++;
        log(`[fail] ${v.id} - ${e?.message || e} (${elapsed}초)${v.channelTitle ? ' [' + v.channelTitle + ']' : ''}`);
        throw e; // 에러를 다시 throw해야 processInBatches에서 제대로 처리됨
      }
    };

    await processInBatches(VIDEOS, worker, {
      concurrency: conc,
      onProgress: ({ processed, total }) => {
        setProgress(processed, total);
        updateSubStatus(processed, total);
      }
    });

    if (ABORT) {
      setStatus('중단됨', `${RESULTS.length}/${VIDEOS.length} 처리됨`);
      log('[run] 사용자 중단');
      btnStart.disabled = false; btnStop.disabled = true;
      return;
    }
    const elapsed = fmtTime(Date.now() - STARTED_AT);
    const cacheInfo = getCacheStats();
    setStatus('완료', `성공 ${SUCC}, 실패 ${FAIL}, 소요 ${elapsed}`);
    log('[run] 완료');
    log(`[cache] 캐시 통계: 히트 ${cacheInfo.hits}, 미스 ${cacheInfo.misses} (히트율 ${cacheInfo.hitRate})`);
    btnStart.disabled = false; btnStop.disabled = true;
  } catch (e) {
    setStatus('실행 실패', e?.message || String(e));
    log('[run] 실패: ' + (e?.message || e));
    btnStart.disabled = false; btnStop.disabled = true;
  }
});

btnStop?.addEventListener('click', () => {
  ABORT = true;
  log('[stop] 중단 요청됨');
  setStatus('중단 요청됨');
});

btnExport?.addEventListener('click', () => {
  if (!RESULTS.length) { alert('내보낼 데이터가 없습니다.'); return; }
  const ch = (Array.isArray(RESOLVED_CHANNELS) && RESOLVED_CHANNELS.length > 1)
    ? 'multi'
    : ((RESOLVED_CHANNELS && RESOLVED_CHANNELS[0]?.id) || RESOLVED_CHANNEL?.id || 'channel');
  exportJson(`transcripts_${ch}_${new Date().toISOString().slice(0,10)}.json`, RESULTS);
});

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function buildPrintableHtml(channel, results) {
  const now = new Date();
  const isMulti = Array.isArray(channel);
  const head = `
    <html lang="ko"><head>
      <meta charset="utf-8">
      <title>Transcripts - ${isMulti ? '여러 채널' : escapeHtml(channel?.title || channel?.id || '')}</title>
      <style>
        body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Pretendard,Apple SD Gothic Neo,Noto Sans KR,sans-serif; color: #111827; margin: 24px; }
        h1 { margin: 0 0 8px 0; }
        h2 { margin: 16px 0 8px 0; }
        h3 { margin: 12px 0 8px 0; font-size: 14px; color: #374151; }
        .muted { color: #6b7280; font-size: 12px; }
        .item { page-break-inside: avoid; margin: 16px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; }
        .meta { color: #374151; font-size: 12px; margin-bottom: 8px; }
        .comments { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
        .comment { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
        .comment-meta { color: #6b7280; font-size: 11px; margin-bottom: 4px; }
        .comment-text { font-size: 13px; line-height: 1.5; }
        pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.5; }
        @media print { .no-print { display:none; } }
      </style>
    </head><body>
      <div class="no-print" style="text-align:right;margin-bottom:8px;">
        <button onclick="window.print()">인쇄/저장</button>
      </div>
      <h1>채널 대본 모음</h1>
      ${isMulti
        ? `<div class="muted">여러 채널(${channel.length}개) • 생성: ${now.toLocaleString('ko-KR')}</div>`
        : `<div class="muted">${escapeHtml(channel?.title || '')} (${escapeHtml(channel?.id || '')}) • 생성: ${now.toLocaleString('ko-KR')}</div>`}
      <div class="muted">총 ${results.length}건 • 성공 ${results.filter(r=>r.transcript).length} • 실패 ${results.filter(r=>!r.transcript).length}</div>
      <hr>
  `;
  const body = results.map((r, idx) => {
    const header = `${idx+1}. ${escapeHtml(r.title || r.id)}`;
    const meta = `ID: ${escapeHtml(r.id)} • 게시일: ${escapeHtml(r.publishedAt || '')}${r.channelTitle ? ' • 채널: ' + escapeHtml(r.channelTitle) : ''}`;
    
    // 대본 내용
    let content = r.transcript
      ? `<pre>${escapeHtml(r.transcript)}</pre>`
      : `<div class="muted">오류: ${escapeHtml(r.error || 'unknown')}</div>`;
    
    // 댓글 추가
    if (r.comments && r.comments.length > 0) {
      const commentsHtml = r.comments.map((c, cIdx) => {
        const likes = c.likes > 0 ? `👍 ${c.likes.toLocaleString()}` : '';
        return `
          <div class="comment">
            <div class="comment-meta">${cIdx + 1}. ${escapeHtml(c.author)} ${likes}</div>
            <div class="comment-text">${escapeHtml(c.text)}</div>
          </div>
        `;
      }).join('');
      
      content += `
        <div class="comments">
          <h3>댓글 (좋아요 상위 ${r.comments.length}개)</h3>
          ${commentsHtml}
        </div>
      `;
    }
    
    return `<div class="item"><h2>${header}</h2><div class="meta">${meta}</div>${content}</div>`;
  }).join('\n');
  const tail = `</body></html>`;
  return head + body + tail;
}

btnExportPdf?.addEventListener('click', () => {
  if (!RESULTS.length) { alert('내보낼 데이터가 없습니다.'); return; }
  const html = buildPrintableHtml(RESOLVED_CHANNEL || {}, RESULTS);
  // 새 창에 HTML을 쓰고 인쇄(사용자가 PDF 선택 가능)
  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  try { w.focus(); } catch {}
  // 일부 브라우저는 load 후 호출해야 함
  w.onload = () => { try { w.print(); } catch {} };
});

async function exportPdfPerChannel() {
  if (!RESULTS.length) { alert('내보낼 데이터가 없습니다.'); return; }
  const channels = Array.isArray(RESOLVED_CHANNELS) && RESOLVED_CHANNELS.length ? RESOLVED_CHANNELS : (RESOLVED_CHANNEL ? [RESOLVED_CHANNEL] : []);
  if (!channels.length) { alert('채널이 확인되지 않았습니다. 먼저 채널 확인을 실행하세요.'); return; }
  let opened = 0;
  for (const ch of channels) {
    if (ABORT) break;
    const list = RESULTS.filter(r => r.channelId === ch.id);
    if (!list.length) continue;
    const html = buildPrintableHtml(ch, list);
    const w = window.open('', '_blank');
    if (!w) { 
      alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    try { w.focus(); } catch {}
    w.onload = () => { try { w.print(); } catch {} };
    opened++;
    await new Promise(r => setTimeout(r, 200));
  }
  if (!opened) {
    alert('채널별 데이터가 없습니다. 먼저 영상 목록/대본 추출을 진행하세요.');
  }
}

btnExportPdfSplit?.addEventListener('click', async () => {
  try {
    await exportPdfPerChannel();
  } catch (e) {
    alert('채널별 PDF 내보내기 실패: ' + (e?.message || e));
  }
});

// init
window.addEventListener('DOMContentLoaded', () => {
  loadLocal();
  setStatus('대기 중', '채널/키를 입력하세요.');
  setProgress(0, 0);
  // date range picker init (optional)
  try {
    if (window.flatpickr && dateRangeInput) {
      const fp = window.flatpickr(dateRangeInput, {
        mode: 'range',
        dateFormat: 'Y-m-d',
        onChange: (selectedDates) => {
          SELECTED_AFTER = (selectedDates && selectedDates.length > 0) ? fmtYMD(selectedDates[0]) : '';
          SELECTED_BEFORE = (selectedDates && selectedDates.length > 1) ? fmtYMD(selectedDates[1]) : '';
        }
      });
      // no preload needed (inputs removed)
    }
  } catch {}
});


