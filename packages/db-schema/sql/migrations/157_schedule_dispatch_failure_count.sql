-- 157: retry a schedule wake that fails before the reservation is given up
--
-- A ResumeAfterLimit reservation used to be closed as failed by its first
-- launch failure, so a session that hit a limit never woke after it lifted.
-- Keep the consecutive launch-failure count on the schedule row so every node
-- backs off the same way and only the last attempt fails the reservation.
ALTER TABLE soulstream_schedules
  ADD COLUMN IF NOT EXISTS dispatch_failure_count INTEGER NOT NULL DEFAULT 0;
