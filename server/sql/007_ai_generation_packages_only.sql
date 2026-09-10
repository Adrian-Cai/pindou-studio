BEGIN;

-- 停用历史下载次数和无限会员套餐；历史订单及订单快照不做修改。
UPDATE pindou_packages
   SET enabled = FALSE,
       updated_at = NOW()
 WHERE id IN ('starter', 'value', 'unlimited')
   AND enabled = TRUE;

COMMIT;
