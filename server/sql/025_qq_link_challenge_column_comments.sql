-- 补全 QQ 绑定码字段注释，满足数据库结构检查。
BEGIN;

COMMENT ON COLUMN pindou_qq_link_challenges.token_hash IS 'QQ 绑定码摘要；不保存明文绑定码';
COMMENT ON COLUMN pindou_qq_link_challenges.user_id IS '签发该绑定码的用户 ID';
COMMENT ON COLUMN pindou_qq_link_challenges.expires_at IS '该绑定码的过期时间';
COMMENT ON COLUMN pindou_qq_link_challenges.consumed_at IS '该绑定码的成功使用时间；NULL 表示尚未使用';
COMMENT ON COLUMN pindou_qq_link_challenges.created_at IS '该绑定码的创建时间';

COMMIT;
