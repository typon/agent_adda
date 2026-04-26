ALTER TABLE agent_cron_jobs
  ADD COLUMN IF NOT EXISTS schedule_kind TEXT NOT NULL DEFAULT 'interval',
  ADD COLUMN IF NOT EXISTS time_of_day TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'PDT';

ALTER TABLE agent_cron_jobs
  ADD CONSTRAINT agent_cron_jobs_schedule_kind_check
  CHECK (schedule_kind IN ('interval', 'daily_time'));

ALTER TABLE agent_cron_jobs
  ADD CONSTRAINT agent_cron_jobs_time_of_day_check
  CHECK (
    (schedule_kind = 'interval' AND time_of_day = '')
    OR (schedule_kind = 'daily_time' AND time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  );
