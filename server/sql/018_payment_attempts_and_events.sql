-- 为虚拟支付保留每次不可复用的商户单号，并记录订单有效期与回调处理结果。
BEGIN;

ALTER TABLE pindou_orders
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

UPDATE pindou_orders
   SET expires_at = created_at + interval '5 minutes'
 WHERE expires_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_orders_user_idempotency
  ON pindou_orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pindou_orders_active_expiry
  ON pindou_orders (user_id, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pindou_payment_attempts (
  id varchar(32) PRIMARY KEY,
  order_id varchar(32) NOT NULL REFERENCES pindou_orders(id) ON DELETE RESTRICT,
  user_id varchar(32) NOT NULL REFERENCES pindou_users(id) ON DELETE RESTRICT,
  out_trade_no varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  wechat_transaction_id varchar(128),
  amount_fen int4 NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'CNY',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  issued_at timestamptz,
  paid_at timestamptz,
  closed_at timestamptz,
  last_query_at timestamptz,
  query_count int4 NOT NULL DEFAULT 0,
  failure_reason varchar(255),
  CONSTRAINT ck_pindou_payment_attempts_status
    CHECK (status IN ('ISSUED', 'SUCCEEDED', 'CLOSED', 'UNKNOWN')),
  CONSTRAINT ck_pindou_payment_attempts_amount
    CHECK (amount_fen > 0),
  CONSTRAINT ck_pindou_payment_attempts_currency
    CHECK (currency = 'CNY'),
  CONSTRAINT ck_pindou_payment_attempts_query_count
    CHECK (query_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_payment_attempts_out_trade_no
  ON pindou_payment_attempts (out_trade_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_payment_attempts_transaction_id
  ON pindou_payment_attempts (wechat_transaction_id)
  WHERE wechat_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pindou_payment_attempts_order_created
  ON pindou_payment_attempts (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pindou_payment_attempts_status_query
  ON pindou_payment_attempts (status, last_query_at);

-- 迁移前订单只保留了最近一次单号；回填这条可见尝试，今后的尝试均独立保留。
INSERT INTO pindou_payment_attempts (
  id, order_id, user_id, out_trade_no, status, wechat_transaction_id,
  amount_fen, currency, created_at, issued_at, paid_at, closed_at
)
SELECT 'pa_' || substr(md5(orders.id), 1, 29), orders.id, orders.user_id,
       orders.virtual_out_trade_no,
       CASE
         WHEN orders.status IN ('paid', 'refunded') THEN 'SUCCEEDED'
         WHEN orders.status = 'closed' THEN 'CLOSED'
         ELSE 'ISSUED'
       END,
       orders.wx_transaction_id, orders.price_fen, 'CNY', orders.created_at,
       orders.created_at, orders.paid_at,
       CASE WHEN orders.status = 'closed' THEN orders.updated_at ELSE NULL END
  FROM pindou_orders orders
 WHERE orders.virtual_out_trade_no IS NOT NULL
ON CONFLICT (out_trade_no) DO NOTHING;

CREATE TABLE IF NOT EXISTS pindou_payment_events (
  id varchar(32) PRIMARY KEY,
  provider varchar(32) NOT NULL,
  event_type varchar(80) NOT NULL,
  event_fingerprint varchar(64) NOT NULL,
  order_id varchar(32) REFERENCES pindou_orders(id) ON DELETE RESTRICT,
  attempt_id varchar(32) REFERENCES pindou_payment_attempts(id) ON DELETE RESTRICT,
  status varchar(24) NOT NULL,
  failure_reason varchar(255),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  processed_at timestamptz,
  CONSTRAINT ck_pindou_payment_events_status
    CHECK (status IN ('RECEIVED', 'PROCESSED', 'QUERY_FAILED', 'DATA_MISMATCH', 'PROCESS_FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_payment_events_provider_fingerprint
  ON pindou_payment_events (provider, event_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pindou_payment_events_status_created
  ON pindou_payment_events (status, created_at);

COMMENT ON TABLE pindou_payment_attempts IS '微信虚拟支付尝试；每个 out_trade_no 永久唯一，不覆盖历史尝试';
COMMENT ON TABLE pindou_payment_events IS '支付回调事件去重与处理状态；不保存原始报文或用户标识';
COMMENT ON COLUMN pindou_orders.expires_at IS '支付有效期截止时间；超时后仍需核对微信事实，不可直接判失败';
COMMENT ON COLUMN pindou_orders.idempotency_key IS '用户创建业务订单时使用的幂等键';
COMMENT ON COLUMN pindou_orders.closed_at IS '订单确认关闭时间；仅在微信支付尝试全部确认关闭后写入';

COMMENT ON COLUMN pindou_payment_attempts.id IS '支付尝试主键，用于区分同一业务订单的历史支付尝试';
COMMENT ON COLUMN pindou_payment_attempts.order_id IS '所属业务订单；限制删除以保留支付审计链路';
COMMENT ON COLUMN pindou_payment_attempts.user_id IS '发起支付的用户；用于归属校验与按用户查询';
COMMENT ON COLUMN pindou_payment_attempts.out_trade_no IS '微信虚拟支付商户单号；永久唯一且不可复用';
COMMENT ON COLUMN pindou_payment_attempts.status IS '支付尝试状态；UNKNOWN 表示微信结果尚不能确认';
COMMENT ON COLUMN pindou_payment_attempts.wechat_transaction_id IS '微信支付交易号；成功确认后用于交易去重';
COMMENT ON COLUMN pindou_payment_attempts.amount_fen IS '本次支付金额，单位为人民币分，必须大于零';
COMMENT ON COLUMN pindou_payment_attempts.currency IS '支付币种；当前仅支持 CNY';
COMMENT ON COLUMN pindou_payment_attempts.created_at IS '本地创建支付尝试的时间';
COMMENT ON COLUMN pindou_payment_attempts.issued_at IS '向客户端签发虚拟支付参数的时间';
COMMENT ON COLUMN pindou_payment_attempts.paid_at IS '微信确认本次尝试支付成功的时间';
COMMENT ON COLUMN pindou_payment_attempts.closed_at IS '微信确认本次尝试关闭的时间';
COMMENT ON COLUMN pindou_payment_attempts.last_query_at IS '最近一次向微信核对本次尝试状态的时间';
COMMENT ON COLUMN pindou_payment_attempts.query_count IS '本次尝试向微信查单的累计次数';
COMMENT ON COLUMN pindou_payment_attempts.failure_reason IS '最近一次查单或确认失败的短摘要；不保存原始报文';

COMMENT ON COLUMN pindou_payment_events.id IS '支付事件主键';
COMMENT ON COLUMN pindou_payment_events.provider IS '事件来源标识，用于区分虚拟支付渠道';
COMMENT ON COLUMN pindou_payment_events.event_type IS '支付或退款推送类型';
COMMENT ON COLUMN pindou_payment_events.event_fingerprint IS '验签后事件内容的摘要，用于同一来源的重复推送去重';
COMMENT ON COLUMN pindou_payment_events.order_id IS '可解析出的业务订单；未能定位时保持为空以供排查';
COMMENT ON COLUMN pindou_payment_events.attempt_id IS '可解析出的支付尝试；未能定位时保持为空以供排查';
COMMENT ON COLUMN pindou_payment_events.status IS '事件处理状态及失败阶段，用于补偿和人工排查';
COMMENT ON COLUMN pindou_payment_events.failure_reason IS '处理失败的短原因码；不保存原始报文或敏感身份';
COMMENT ON COLUMN pindou_payment_events.created_at IS '收到已验签支付推送并记录事件的时间';
COMMENT ON COLUMN pindou_payment_events.processed_at IS '本次事件最近一次处理结束的时间';

COMMIT;
