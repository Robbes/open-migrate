-- Add target_mail_server column to cutover_state
-- Used to track the target mail server during cutover

ALTER TABLE cutover_state 
ADD COLUMN target_mail_server text;
