BEGIN;

CREATE INDEX IF NOT EXISTS idx_pindou_orders_user_created
  ON pindou_orders (user_id, created_at DESC);

COMMIT;
