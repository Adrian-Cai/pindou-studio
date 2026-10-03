-- 成功文生图原图作为独立作品长期保存，不伪造拼豆图纸。
BEGIN;

CREATE TABLE IF NOT EXISTS pindou_text_image_works (
  id varchar(32) PRIMARY KEY,
  user_id varchar(32) NOT NULL REFERENCES pindou_users(id) ON DELETE RESTRICT,
  source_job_id varchar(32) NOT NULL,
  image_file_id varchar(32) NOT NULL REFERENCES pindou_file_assets(id) ON DELETE RESTRICT,
  prompt varchar(500) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT ck_pindou_text_image_works_prompt
    CHECK (char_length(prompt) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_text_image_works_user_source
  ON pindou_text_image_works (source_job_id);
CREATE INDEX IF NOT EXISTS idx_pindou_text_image_works_user_created
  ON pindou_text_image_works (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE pindou_text_image_works IS '持久化的文生图原始图片作品，不含拼豆图纸';
COMMENT ON COLUMN pindou_text_image_works.id IS '文生图原图作品的服务端编号';
COMMENT ON COLUMN pindou_text_image_works.user_id IS '创建并拥有该文生图原图作品的用户';
COMMENT ON COLUMN pindou_text_image_works.source_job_id IS '来源文生图任务编号；唯一约束保障每个任务最多保存一份作品';
COMMENT ON COLUMN pindou_text_image_works.image_file_id IS '长期封面存储中的原始生成图文件';
COMMENT ON COLUMN pindou_text_image_works.prompt IS '用户提交并用于生成该原图的画面描述';
COMMENT ON COLUMN pindou_text_image_works.created_at IS '原图作品首次保存的时间';
COMMENT ON COLUMN pindou_text_image_works.updated_at IS '原图作品最近修改或删除的时间';
COMMENT ON COLUMN pindou_text_image_works.deleted_at IS '原图作品删除时间；非空时不再出现在作品列表';

COMMIT;
