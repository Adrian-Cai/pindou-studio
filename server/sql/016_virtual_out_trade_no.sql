-- 虚拟支付商户单号（outTradeNo）与订单号解耦。
--
-- 背景：此前 signData 里的 outTradeNo 直接取 pindou_orders.id。微信规定一个
-- outTradeNo **只能用于一次支付尝试**，第二次拿同一单号拉起支付直接失败：
--   requestVirtualPayment:fail ORDER_CLOSED（errCode -15012，「请换新单号重试」）。
-- 而同一笔订单在用户取消、支付失败、下单接口超时重发后必然被反复拉起，
-- 于是「幂等键复用 ⇒ 订单号不变 ⇒ 商户单号不变」这条链路必然撞上 -15012，
-- 且由于客户端失败时保留幂等键，用户之后每次点购买都撞同一个单号，永远出不去。
--
-- 修法：订单号继续做我方主键与幂等依据，另发一个每次都新的商户单号单独存一列，
-- 发货推送 / 退款推送 / iOS 退款问询 / 补单查单一律以这一列为准。
BEGIN;

ALTER TABLE pindou_orders
  ADD COLUMN IF NOT EXISTS virtual_out_trade_no varchar(32);

COMMENT ON COLUMN pindou_orders.virtual_out_trade_no
  IS '微信虚拟支付商户单号（outTradeNo），每次签发支付参数都会换新；发货与退款回调凭它定位订单';

-- 回填历史订单：迁移前商户单号就是订单号本身，回填后存量在途订单的发货/退款仍能回查。
UPDATE pindou_orders
   SET virtual_out_trade_no = id
 WHERE virtual_out_trade_no IS NULL;

-- 部分唯一索引：未签发过支付参数的旧订单（或还没走到支付的订单）该列为空，不应互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_orders_virtual_out_trade_no
  ON pindou_orders (virtual_out_trade_no)
  WHERE virtual_out_trade_no IS NOT NULL;

COMMIT;
