-- QQ 登录身份与微信账号安全绑定；现有账号保持微信身份，会话默认微信平台。
BEGIN;

ALTER TABLE pindou_users
  ADD COLUMN IF NOT EXISTS qq_openid_hash varchar(128),
  ADD COLUMN IF NOT EXISTS qq_openid_ciphertext text;

ALTER TABLE pindou_auth_sessions
  ADD COLUMN IF NOT EXISTS login_provider varchar(16) NOT NULL DEFAULT 'wechat';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_users_qq_openid_hash
  ON pindou_users (qq_openid_hash)
  WHERE qq_openid_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS pindou_qq_link_challenges (
  token_hash varchar(128) PRIMARY KEY,
  user_id varchar(32) NOT NULL REFERENCES pindou_users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT ck_pindou_qq_link_challenges_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_pindou_qq_link_challenges_user
  ON pindou_qq_link_challenges (user_id);

ALTER TABLE pindou_auth_sessions
  ADD CONSTRAINT ck_pindou_auth_sessions_login_provider
  CHECK (login_provider IN ('wechat', 'qq'));

COMMENT ON COLUMN pindou_users.qq_openid_hash IS 'QQ 登录身份摘要；用于唯一识别 QQ 账号';
COMMENT ON COLUMN pindou_users.qq_openid_ciphertext IS 'QQ 登录身份密文；不以明文保存';
COMMENT ON COLUMN pindou_auth_sessions.login_provider IS '创建本会话的平台；历史会话默认微信';
COMMENT ON TABLE pindou_qq_link_challenges IS '由已登录微信账号签发的一次性 QQ 绑定码摘要';

COMMIT;
