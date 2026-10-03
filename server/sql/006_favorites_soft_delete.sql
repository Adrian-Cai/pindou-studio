BEGIN;

ALTER TABLE pindou_favorites
  ADD COLUMN IF NOT EXISTS favorited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

UPDATE pindou_favorites
   SET favorited_at = created_at
 WHERE favorited_at IS NULL;

ALTER TABLE pindou_favorites
  ALTER COLUMN favorited_at SET NOT NULL;

COMMENT ON COLUMN pindou_favorites.created_at IS
  '首次建立收藏关系的时间，关系恢复时保持不变';
COMMENT ON COLUMN pindou_favorites.favorited_at IS
  '最近一次进入有效收藏状态的时间，用于收藏列表展示和排序';
COMMENT ON COLUMN pindou_favorites.deleted_at IS
  '取消收藏时间；NULL 表示当前收藏有效';

CREATE INDEX IF NOT EXISTS idx_pindou_favorites_active_recent
  ON pindou_favorites (user_id, favorited_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
