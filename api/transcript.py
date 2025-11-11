import json
import re
import os
from typing import Dict, Any, List
import time
from collections import OrderedDict
from flask import Flask, request, jsonify

try:
    from yt_dlp import YoutubeDL
except Exception as e:
    YoutubeDL = None  # vercel 빌드 실패 시 런타임 에러 메시지 제공

try:
    import requests
except Exception:
    requests = None

try:
    # use public exports; avoid importing private module `_errors`
    from youtube_transcript_api import (
        YouTubeTranscriptApi,
        TranscriptsDisabled,
        NoTranscriptFound,
        VideoUnavailable,
    )
    from youtube_transcript_api.proxies import WebshareProxyConfig
except Exception:
    YouTubeTranscriptApi = None
    WebshareProxyConfig = None
    class _TranscriptApiImportFallback(Exception):
        pass
    TranscriptsDisabled = NoTranscriptFound = VideoUnavailable = _TranscriptApiImportFallback

app = Flask(__name__)

# Basic CORS so frontend (e.g., Vite dev server) can call this API directly
@app.after_request
def add_cors_headers(resp):
    try:
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
    except Exception:
        pass
    return resp

DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit(537.36) (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'ko,en;q=0.9',
    'Connection': 'keep-alive',
}

# -------- Bandwidth-aware caching & toggles --------
_CACHE_TTL_SEC = int(os.getenv('TRANSCRIPT_CACHE_TTL_SEC') or '86400')  # 24h
_CACHE_MAX = int(os.getenv('TRANSCRIPT_CACHE_SIZE') or '500')
_STT_FALLBACK_ENABLED = (os.getenv('STT_FALLBACK_ENABLED') or '0').strip() in ('1', 'true', 'yes')

class _LRUCache:
    def __init__(self, cap: int):
        self.cap = max(1, cap)
        self.map: OrderedDict[str, Any] = OrderedDict()
    def get(self, k: str):
        if k not in self.map:
            return None
        v = self.map.pop(k)
        # v = (ts, data)
        self.map[k] = v
        return v
    def set(self, k: str, v: Any):
        if k in self.map:
            self.map.pop(k)
        self.map[k] = v
        while len(self.map) > self.cap:
            self.map.popitem(last=False)

_cache = _LRUCache(_CACHE_MAX)

def _pick_audio_url(info: Dict[str, Any]) -> str:
    try:
        formats = info.get('formats') or []
        # best audio-only format
        audio_only = [f for f in formats if f.get('vcodec') in (None, 'none') and f.get('acodec') not in (None, 'none') and f.get('url')]
        # prefer m4a/webm opus by abr
        audio_only.sort(key=lambda f: (f.get('abr') or 0), reverse=True)
        return audio_only[0]['url'] if audio_only else ''
    except Exception:
        return ''

def _stt_with_deepgram(audio_url: str, preferred_langs: List[str]) -> Dict[str, Any]:
    import os
    api_key = os.getenv('DEEPGRAM_API_KEY')
    if not api_key or not audio_url:
        return {}
    # choose language
    lang = 'en'
    for p in preferred_langs:
        if p.startswith('ko'):
            lang = 'ko'
            break
        if p.startswith('en'):
            lang = 'en'
            break
    payload = { 'url': audio_url }
    resp = requests.post(
        f'https://api.deepgram.com/v1/listen?language={lang}&smart_format=true',
        headers={'Authorization': f'Token {api_key}', 'Content-Type': 'application/json'},
        data=json.dumps(payload), timeout=60
    )
    if resp.status_code != 200:
        return {}
    data = resp.json()
    # extract transcript text
    try:
        channels = data.get('results', {}).get('channels', [])
        alts = channels[0].get('alternatives', []) if channels else []
        transcript = alts[0].get('transcript', '') if alts else ''
        return { 'text': transcript, 'lang': lang, 'ext': 'stt' }
    except Exception:
        return {}

def _best_caption_track(info: Dict[str, Any]) -> Dict[str, Any]:
    subtitles = info.get('subtitles') or {}
    auto = info.get('automatic_captions') or {}
    # 병합
    merged: Dict[str, List[Dict[str, Any]]] = {}
    for source in (subtitles, auto):
        for lang, items in source.items():
            merged.setdefault(lang, []).extend(items or [])

    # 선호 언어/확장자 우선순위
    preferred_langs = ['ko', 'ko-KR', 'ko-kr', 'en', 'en-US', 'en-us']
    preferred_exts = ['vtt', 'srt']

    # 1) 선호 언어 + 선호 확장자
    for lang in preferred_langs:
        for ext in preferred_exts:
            for cand in merged.get(lang, []):
                if cand.get('ext') == ext and cand.get('url'):
                    return cand

    # 2) 아무 언어라도 선호 확장자
    for lang, items in merged.items():
        for ext in preferred_exts:
            for cand in items:
                if cand.get('ext') == ext and cand.get('url'):
                    return cand

    # 3) 아무거나 첫 번째
    for items in merged.values():
        for cand in items:
            if cand.get('url'):
                return cand
    return {}


def _strip_vtt(vtt: str) -> str:
    text = re.sub(r'^WEBVTT[\s\S]*?\n\n', '', vtt, flags=re.MULTILINE)
    text = re.sub(r"\d{2}:\d{2}:\d{2}\.\d{3} --> [^\n]+\n", '', text)
    text = re.sub(r"<[^>]+>", '', text)
    text = re.sub(r"\n{2,}", '\n', text)
    return text.strip()


def _strip_srt(srt: str) -> str:
    # 인덱스 줄 제거
    text = re.sub(r"^\d+\s*$", '', srt, flags=re.MULTILINE)
    # 타임코드 제거
    text = re.sub(r"\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\s*\n", '', text)
    text = re.sub(r"<[^>]+>", '', text)
    text = re.sub(r"\n{2,}", '\n', text)
    return text.strip()


def _to_plain_text(body: str, ext: str) -> str:
    ext = (ext or '').lower()
    if ext == 'vtt':
        return _strip_vtt(body)
    if ext == 'srt':
        return _strip_srt(body)
    # fallback: 그냥 본문 반환
    return body


@app.route('/', methods=['GET'])
@app.route('/transcript', methods=['GET'])
@app.route('/api/transcript', methods=['GET'])
def transcript_root():
    try:
        if YouTubeTranscriptApi is None:
            return jsonify({ 'error': 'youtube_transcript_api not available' }), 500

        url = request.args.get('url')
        lang_pref_raw = (request.args.get('lang') or '').strip().lower()
        preferred_langs = [s.strip() for s in (lang_pref_raw or 'ko,en').split(',') if s.strip()]
        # stt fallback toggle: default off to save bandwidth; allow ?stt=1 to force
        stt_query = (request.args.get('stt') or '').strip().lower() in ('1','true','yes')
        stt_enabled = _STT_FALLBACK_ENABLED or stt_query
        if not url:
            return jsonify({ 'error': 'url query required' }), 400

        # Extract video ID
        vid = None
        try:
            if 'watch?v=' in url:
                vid = url.split('watch?v=')[1].split('&')[0]
            elif 'youtu.be/' in url:
                vid = url.split('youtu.be/')[1].split('?')[0]
            elif '/shorts/' in url:
                vid = url.split('/shorts/')[1].split('?')[0]
            elif 'youtube.com/embed/' in url:
                vid = url.split('/embed/')[1].split('?')[0]
        except Exception:
            vid = None
        
        if not vid:
            # Fallback: assume the URL itself is the video ID
            vid = url

        # Cache key: (vid|langs)
        cache_key = f"{vid}|{','.join(preferred_langs)}"
        cv = _cache.get(cache_key)
        if cv:
            ts, data = cv
            if (time.time() - ts) <= _CACHE_TTL_SEC:
                return jsonify(data), 200

        # Initialize YouTubeTranscriptApi with proxy if available
        proxy_config = None
        proxy_username = os.getenv('WEBSHARE_PROXY_USERNAME')
        proxy_password = os.getenv('WEBSHARE_PROXY_PASSWORD')
        
        if WebshareProxyConfig and proxy_username and proxy_password:
            # Use Webshare rotating residential proxies to avoid IP blocks
            proxy_config = WebshareProxyConfig(
                proxy_username=proxy_username,
                proxy_password=proxy_password,
            )
        
        ytt_api = YouTubeTranscriptApi(proxy_config=proxy_config) if proxy_config else YouTubeTranscriptApi()
        
        try:
            # Try fetching with preferred languages
            fetched = None
            error_msg = None
            
            # First try with preferred languages
            for lang in preferred_langs:
                try:
                    fetched = ytt_api.fetch(vid, languages=[lang])
                    if fetched:
                        break
                except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable) as e:
                    error_msg = str(e)
                    continue
                except Exception as e:
                    error_msg = str(e)
                    # Check for IP block errors
                    if 'RequestBlocked' in str(e) or 'IpBlocked' in str(e):
                        return jsonify({ 'error': 'ip_blocked', 'detail': 'YouTube blocked the request. Configure proxy settings.' }), 429
                    continue
            
            # If no preferred language worked, try without language preference
            if not fetched:
                try:
                    fetched = ytt_api.fetch(vid)
                except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable) as e:
                    error_msg = str(e)
                    fetched = None
                except Exception as e:
                    if 'RequestBlocked' in str(e) or 'IpBlocked' in str(e):
                        return jsonify({ 'error': 'ip_blocked', 'detail': 'YouTube blocked the request. Configure proxy settings.' }), 429
                    error_msg = str(e)
                    fetched = None
            
            # If we still don't have text, optional fallback to STT (Deepgram) using YoutubeDL audio URL
            text = ''
            if fetched:
                text = '\n'.join([snip.text for snip in fetched if getattr(snip, 'text', '')])
            if not text.strip() and stt_enabled:
                try:
                    if YoutubeDL is None:
                        raise RuntimeError('yt-dlp not available')
                    # keep requests minimal; do not download media
                    with YoutubeDL({'quiet': True, 'skip_download': True, 'nocheckcertificate': True}) as ydl:
                        info = ydl.extract_info(url, download=False)
                    audio_url = _pick_audio_url(info) if info else ''
                    stt = _stt_with_deepgram(audio_url, preferred_langs)
                    text = stt.get('text', '') if isinstance(stt, dict) else ''
                except Exception:
                    text = ''
            
            if text.strip():
                payload = {
                    'text': text,
                    'lang': getattr(fetched, 'language_code', None),
                    'ext': 'transcript' if fetched else 'stt'
                }
                _cache.set(cache_key, (time.time(), payload))
                return jsonify(payload), 200
            else:
                # choose best error message
                return jsonify({ 'error': 'no_transcript_or_stt', 'detail': error_msg or 'empty' }), 404
                
        except Exception as e:
            # Generic error handling
            error_str = str(e)
            if 'RequestBlocked' in error_str or 'IpBlocked' in error_str:
                return jsonify({ 'error': 'ip_blocked', 'detail': 'YouTube blocked the request. Configure proxy settings.' }), 429
            return jsonify({ 'error': 'unexpected_error', 'detail': error_str }), 500

    except Exception as e:
        return jsonify({ 'error': str(e) }), 500


@app.route('/health', methods=['GET'])
def health():
    return ('ok', 200)

@app.route('/api/transcript/health', methods=['GET'])
def health_alias():
    return ('ok', 200)


if __name__ == '__main__':
    # Run local server on the same port the frontend expects by default
    app.run(host='0.0.0.0', port=8787)


