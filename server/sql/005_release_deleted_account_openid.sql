BEGIN;

ALTER TABLE pindou_users
  ALTER COLUMN openid_hash DROP NOT NULL;

UPDATE pindou_users
   SET openid_hash = NULL,
       openid_ciphertext = NULL
 WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN pindou_users.openid_hash IS
  '当前有效账号的微信 OpenID 摘要；账号注销后清空，以允许同一微信重新注册新账号';

COMMIT;
