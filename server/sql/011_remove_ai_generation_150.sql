-- 下架 AI 精致生成 150 次套餐，保留历史订单和已发放额度。
BEGIN;

UPDATE pindou_packages
   SET enabled = FALSE,
       updated_at = NOW()
 WHERE id = 'ai_generation_150'
   AND enabled = TRUE;

COMMIT;
