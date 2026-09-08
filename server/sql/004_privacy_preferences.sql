BEGIN;

ALTER TABLE pindou_users
  ADD COLUMN IF NOT EXISTS privacy_local_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS privacy_cloud_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS privacy_service_notices boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS privacy_personalized_recommendations boolean NOT NULL DEFAULT false;

UPDATE pindou_users
   SET privacy_local_only = COALESCE(privacy_local_only, TRUE),
       privacy_cloud_sync = CASE
         WHEN COALESCE(privacy_local_only, TRUE) THEN FALSE
         ELSE COALESCE(privacy_cloud_sync, FALSE)
       END,
       privacy_service_notices = COALESCE(privacy_service_notices, TRUE),
       privacy_personalized_recommendations = COALESCE(privacy_personalized_recommendations, FALSE)
 WHERE privacy_local_only IS NULL
    OR privacy_cloud_sync IS NULL
    OR privacy_service_notices IS NULL
    OR privacy_personalized_recommendations IS NULL
    OR (privacy_local_only AND privacy_cloud_sync);

ALTER TABLE pindou_users
  ALTER COLUMN privacy_local_only SET DEFAULT true,
  ALTER COLUMN privacy_cloud_sync SET DEFAULT false,
  ALTER COLUMN privacy_service_notices SET DEFAULT true,
  ALTER COLUMN privacy_personalized_recommendations SET DEFAULT false,
  ALTER COLUMN privacy_local_only SET NOT NULL,
  ALTER COLUMN privacy_cloud_sync SET NOT NULL,
  ALTER COLUMN privacy_service_notices SET NOT NULL,
  ALTER COLUMN privacy_personalized_recommendations SET NOT NULL;

ALTER TABLE pindou_users
  DROP CONSTRAINT IF EXISTS ck_pindou_users_privacy_storage_mode,
  ADD CONSTRAINT ck_pindou_users_privacy_storage_mode
    CHECK (NOT (privacy_local_only AND privacy_cloud_sync));

COMMENT ON COLUMN pindou_users.privacy_local_only IS '仅在本地保存作品，不上传到云端';
COMMENT ON COLUMN pindou_users.privacy_cloud_sync IS '允许作品同步到云端';
COMMENT ON COLUMN pindou_users.privacy_service_notices IS '允许接收服务通知';
COMMENT ON COLUMN pindou_users.privacy_personalized_recommendations IS '允许基于使用偏好进行个性化推荐';

COMMIT;
