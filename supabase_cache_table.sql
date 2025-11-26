-- Supabase 캐시 테이블 생성 SQL
-- 이 SQL을 Supabase SQL Editor에서 실행하세요

-- 캐시 테이블 생성
CREATE TABLE IF NOT EXISTS transcript_cache (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,
  video_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_transcript_cache_video_id ON transcript_cache(video_id);
CREATE INDEX IF NOT EXISTS idx_transcript_cache_created_at ON transcript_cache(created_at);

-- 자동 업데이트 트리거
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_transcript_cache_updated_at ON transcript_cache;
CREATE TRIGGER update_transcript_cache_updated_at
  BEFORE UPDATE ON transcript_cache
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 30일 이상 된 캐시 자동 삭제 (선택사항 - pg_cron 확장 필요)
-- SELECT cron.schedule('cleanup-old-cache', '0 3 * * *', $$
--   DELETE FROM transcript_cache WHERE created_at < NOW() - INTERVAL '30 days';
-- $$);

-- RLS 정책 (필요시)
-- ALTER TABLE transcript_cache ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all access" ON transcript_cache FOR ALL USING (true);

-- 테이블 확인
SELECT 'transcript_cache 테이블이 생성되었습니다.' as message;

