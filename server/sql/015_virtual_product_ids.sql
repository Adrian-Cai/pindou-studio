-- 绑定 MP 后台「虚拟支付 → 道具管理」中已发布道具的 ID 到三个 AI 生成套餐。
--
-- 前置条件：
--   1. 三个道具必须已在 MP 后台「发布到现网」（约 10 分钟生效），否则下单会报 -15010（道具未发布）。
--   2. 后台道具定价（元）必须与服务端 price_fen（分）一致：新人 0.1 元 / 30 次 9.9 元 / 80 次 19.9 元，
--      否则下单会报 -15013（goodsPrice 与后台价不一致）。本表种子价已是 10 / 990 / 1990 分，无需改价。
--
-- 重要：virtual_product_id 三个值是【占位符】，必须替换成 MP 后台「道具管理」列表里
--       对应道具的实际 ID（不是 OfferID，也不是 orderId）。替换后整段执行。
--       新人套餐道具 ID 来自联调用的 0.1 元道具；30 次 / 80 次对应各自定价道具。
BEGIN;

UPDATE pindou_packages
  SET virtual_product_id = '<NEW_USER_5_PRODUCT_ID>'
  WHERE id = 'ai_generation_new_user_5'
    AND quota_kind = 'ai_generation'
    AND price_fen = 10;

UPDATE pindou_packages
  SET virtual_product_id = '<AI_GEN_30_PRODUCT_ID>'
  WHERE id = 'ai_generation_30'
    AND quota_kind = 'ai_generation'
    AND price_fen = 990;

UPDATE pindou_packages
  SET virtual_product_id = '<AI_GEN_80_PRODUCT_ID>'
  WHERE id = 'ai_generation_80'
    AND quota_kind = 'ai_generation'
    AND price_fen = 1990;

COMMIT;

-- 校验：三条都应返回各 1 row（updated=1）。若某条 0 row，说明 id / price_fen 对不上，先查后改：
-- SELECT id, label, price_fen, virtual_product_id
--   FROM pindou_packages
--   WHERE id IN ('ai_generation_new_user_5', 'ai_generation_30', 'ai_generation_80')
--   ORDER BY price_fen;
