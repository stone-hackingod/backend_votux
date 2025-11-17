-- Normalize election status values and enum
-- 1) If status column is ENUM from older schema, ensure allowed values
ALTER TABLE elections
  MODIFY COLUMN status ENUM('pending','ongoing','closed','cancelled') DEFAULT 'pending';

-- 2) Map legacy/empty values to the normalized set
UPDATE elections SET status = 'pending'  WHERE status IS NULL OR status = '' OR status = 'draft';
UPDATE elections SET status = 'ongoing'  WHERE status = 'active';
UPDATE elections SET status = 'closed'   WHERE status = 'completed';

-- 3) Optional helpful indexes
CREATE INDEX IF NOT EXISTS idx_status ON elections(status);
CREATE INDEX IF NOT EXISTS idx_dates ON elections(start_date, end_date);
