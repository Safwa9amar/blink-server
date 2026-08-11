-- Public storage bucket for support-chat photo attachments. The mobile client
-- uploads directly (authenticated); reads are public so the URL renders in the
-- app and dashboard.
INSERT INTO storage.buckets (id, name, public)
VALUES ('support-attachments', 'support-attachments', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "support_attachments_insert_auth" ON storage.objects;
CREATE POLICY "support_attachments_insert_auth" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'support-attachments');
