-- 虚拟支付支撑：用户留存 session_key、套餐关联 MP 后台道具 ID。
--
-- 背景：小程序内售卖的 AI 生成次数属于虚拟商品，官方要求必须走虚拟支付
-- （wx.requestVirtualPayment），该链路的用户态签名 signature 需要 session_key，
-- 而旧登录流程把 code2session 返回的 session_key 直接丢弃了。
BEGIN;

-- 1. 用户表：加密存储 session_key。
--    与 openid_ciphertext 同为 AES-256-GCM 密文，泄露等于他人可伪造该用户的支付签名，
--    因此绝不能明文。每次用户登录都会覆盖刷新。
ALTER TABLE pindou_users
  ADD COLUMN IF NOT EXISTS session_key_ciphertext text;

COMMENT ON COLUMN pindou_users.session_key_ciphertext
  IS '加密后的微信 session_key（v1.<nonce>.<ciphertext+tag>），用于虚拟支付用户态签名';

-- 2. 套餐表：关联 MP 后台「虚拟支付 → 道具管理」中已发布的道具 ID。
--    虚拟支付下单必须传 productId 且 goodsPrice 要与后台道具定价一致（否则 -15013），
--    所以套餐与道具必须显式对应，不能靠名称推导。
--    允许为 NULL 是为了让尚未配置道具的下架套餐仍然合法，只有参与支付的才必须是非空。
ALTER TABLE pindou_packages
  ADD COLUMN IF NOT EXISTS virtual_product_id varchar(64);

COMMENT ON COLUMN pindou_packages.virtual_product_id
  IS 'MP 后台虚拟支付道具 ID，参与售卖的套餐必须配置且与后台已发布道具一致';

COMMIT;
