// 독립 페이지: 채널 전체 대본 추출기
// - YouTube Data API 키 회전
// - Transcript 서버 호출(/transcript) — 서버가 Webshare 등 프록시 구성 시 IP 회전
// - Supabase 등 DB 연동 없음. 결과는 메모리에 유지 후 JSON 내보내기

// DOM
const chInput = document.getElementById('ch-input');
const srvInput = document.getElementById('srv-input');
const keysInput = document.getElementById('keys-input');
const saveKeysBtn = document.getElementById('save-keys');
const testKeyBtn = document.getElementById('test-key');
const keysStatus = document.getElementById('keys-status');
const maxVideosInput = document.getElementById('max-videos');
const concInput = document.getElementById('conc-input');
const sttInput = document.getElementById('stt-input');
const minViewsInput = document.getElementById('min-views');
const dateRangeInput = document.getElementById('date-range');
const btnResolve = document.getElementById('resolve-ch');
const btnList = document.getElementById('list-videos');
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

// State
let ALL_KEYS = [];
let KEY_INDEX = 0;
let VIDEOS = []; // { id, title, publishedAt, url, views }
let RESULTS = []; // { id, title, publishedAt, transcript, error }
let ABORT = false;
let RESOLVED_CHANNEL = null; // { id, title }
let RESOLVED_CHANNELS = []; // [{ id, title }]
let STARTED_AT = 0;
let SUCC = 0;
let FAIL = 0;
let SELECTED_AFTER = '';
let SELECTED_BEFORE = '';

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
      publishedAfter: publishedAfter ? new Date(publishedAfter).toISOString() : undefined,
      publishedBefore: publishedBefore ? new Date(publishedBefore).toISOString() : undefined
    });
    try {
      const j = await ytFetch(url);
      const items = Array.isArray(j.items) ? j.items : [];
      for (const it of items) {
        const id = it.id?.videoId;
        if (!id) continue;
        all.push({
          id,
          title: it.snippet?.title || '',
          publishedAt: it.snippet?.publishedAt || '',
          url: `https://www.youtube.com/watch?v=${id}`
        });
        if (maxCount && all.length >= maxCount) break;
      }
      if (maxCount && all.length >= maxCount) break;
      pageToken = j.nextPageToken || '';
      if (!pageToken) break;
      // QPS 완화
      await new Promise(r => setTimeout(r, 120 + Math.random()*120));
    } catch (e) {
      log(`[list] 오류: ${e?.message || e} — 키 교체/대기`);
      await new Promise(r => setTimeout(r, 800 + Math.random()*600));
      continue;
    }
  }
  // 조회수 조회
  try {
    const ids = all.map(v => v.id);
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
          if (viewsMap.has(v.id)) v.views = viewsMap.get(v.id) || 0;
        }
      } catch (e) {
        log(`[list] views 오류: ${e?.message || e}`);
      }
      await new Promise(r => setTimeout(r, 120 + Math.random()*120));
    }
  } catch (e) {
    log(`[list] 조회수 조회 실패: ${e?.message || e}`);
  }
  // 필터 적용
  const filtered = (minViews ? all.filter(v => (v.views || 0) >= minViews) : all);
  return filtered;
}

async function fetchTranscriptByUrl(serverBase, youtubeUrl, useStt) {
  const url = serverBase.replace(/\/$/, '') + '/transcript?url=' + encodeURIComponent(youtubeUrl) + '&lang=ko,en' + (useStt ? '&stt=1' : '');
  const res = await fetch(url);
  if (!res.ok) {
    let reason = '';
    try { const j = await res.json(); reason = j && j.error ? String(j.error) : ''; } catch {}
    throw new Error('Transcript http ' + res.status + (reason ? (' ' + reason) : ''));
  }
  const data = await res.json();
  return data.text || '';
}

async function processInBatches(items, worker, { concurrency = 8, onProgress } = {}) {
  return await new Promise((resolve) => {
    let i = 0, inFlight = 0, done = 0, failed = 0;
    const total = items.length;
    const pump = () => {
      if (ABORT) return resolve({ done, failed, aborted: true });
      if (done + failed >= total && inFlight === 0) return resolve({ done, failed });
      while (inFlight < concurrency && i < total && !ABORT) {
        const idx = i++;
        const item = items[idx];
        inFlight++;
        worker(item).then(() => { done++; }).catch(() => { failed++; }).finally(() => {
          inFlight--;
          if (typeof onProgress === 'function') {
            try { onProgress({ processed: done + failed, total }); } catch {}
          }
          pump();
        });
      }
    };
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
  } catch {}
}

function loadLocal() {
  try {
    const k = localStorage.getItem('ce_keys') || '';
    const s = localStorage.getItem('ce_server') || '';
    if (k) keysInput.value = k;
    if (s) srvInput.value = s;
  } catch {}
}

// Events
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

btnStart?.addEventListener('click', async () => {
  try {
    if (!VIDEOS.length) {
      // 편의: 목록이 없으면 자동으로 불러오기
      await btnList?.click();
      if (!VIDEOS.length) return;
    }
    ABORT = false;
    RESULTS = [];
    SUCC = 0; FAIL = 0;
    STARTED_AT = Date.now();
    btnStart.disabled = true; btnStop.disabled = false;
    const server = getServerBase();
    const useStt = String(sttInput.value || '0') === '1';
    const conc = Math.max(1, Math.min(20, Number(concInput.value || 8)));
    setStatus('대본 추출 진행 중...', `${conc} 동시`);
    setProgress(0, VIDEOS.length);
    log(`[run] ${VIDEOS.length}개, 동시성 ${conc}, STT=${useStt?'on':'off'}`);

    const worker = async (v) => {
      if (ABORT) throw new Error('abort');
      try {
        const text = await fetchTranscriptByUrl(server, v.url, useStt);
        RESULTS.push({ id: v.id, title: v.title, publishedAt: v.publishedAt, transcript: text, channelId: v.channelId, channelTitle: v.channelTitle });
        SUCC++;
        log(`[ok] ${v.id} (${(text||'').length} chars)${v.channelTitle ? ' [' + v.channelTitle + ']' : ''}`);
      } catch (e) {
        RESULTS.push({ id: v.id, title: v.title, publishedAt: v.publishedAt, error: (e?.message || String(e)), channelId: v.channelId, channelTitle: v.channelTitle });
        FAIL++;
        log(`[fail] ${v.id} ${e?.message || e}${v.channelTitle ? ' [' + v.channelTitle + ']' : ''}`);
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
    setStatus('완료', `성공 ${SUCC}, 실패 ${FAIL}, 소요 ${elapsed}`);
    log('[run] 완료');
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
        .muted { color: #6b7280; font-size: 12px; }
        .item { page-break-inside: avoid; margin: 16px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; }
        .meta { color: #374151; font-size: 12px; margin-bottom: 8px; }
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
    const content = r.transcript
      ? `<pre>${escapeHtml(r.transcript)}</pre>`
      : `<div class="muted">오류: ${escapeHtml(r.error || 'unknown')}</div>`;
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


