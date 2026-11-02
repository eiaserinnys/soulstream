ALTER TABLE cards DROP CONSTRAINT cards_status_check;
ALTER TABLE cards ADD CONSTRAINT cards_status_check CHECK(status IN ('todo','queued','blocked','running','review','on_hold','done','cancelled'));
