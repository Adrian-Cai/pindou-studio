-- 新人测试福利：每个尚未成功购买 AI 生成次数的账号限购一次。
-- 该套餐仅用于支付联调，正式发布前应下架。
BEGIN;

INSERT INTO pindou_packages (
  id, label, quota_amount, quota_kind, membership_type, membership_days,
  price_fen, currency, enabled, sort_order, created_at, updated_at
) VALUES (
  'ai_generation_new_user_5',
  '新人测试福利 · AI 生成 5 次',
  5,
  'ai_generation',
  NULL,
  NULL,
  10,
  'CNY',
  TRUE,
  5,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE
   SET label = EXCLUDED.label,
       quota_amount = EXCLUDED.quota_amount,
       quota_kind = EXCLUDED.quota_kind,
       membership_type = EXCLUDED.membership_type,
       membership_days = EXCLUDED.membership_days,
       price_fen = EXCLUDED.price_fen,
       currency = EXCLUDED.currency,
       enabled = EXCLUDED.enabled,
       sort_order = EXCLUDED.sort_order,
       updated_at = NOW();

COMMIT;
