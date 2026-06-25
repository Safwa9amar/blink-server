-- Public storage bucket for support-chat photo attachments. The server uploads
-- via the service role (bypasses RLS); reads are public so the URL renders in
-- the app and dashboard.
INSERT INTO storage.buckets (id, name, public)
VALUES ('support-attachments', 'support-attachments', true)
ON CONFLICT (id) DO NOTHING;
