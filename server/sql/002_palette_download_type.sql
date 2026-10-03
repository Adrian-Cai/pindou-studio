BEGIN;

ALTER TABLE pindou_download_records
  DROP CONSTRAINT IF EXISTS ck_pindou_download_records_file_type;

ALTER TABLE pindou_download_records
  ADD CONSTRAINT ck_pindou_download_records_file_type
    CHECK (file_type IN ('preview', 'chart', 'materials', 'palette'));

COMMIT;
