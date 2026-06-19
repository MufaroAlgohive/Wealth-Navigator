-- Allow specific admin users to view child documents in storage buckets.
-- Buckets covered: birth-certificates, signed-agreements
-- NOTE:
-- Do not ALTER storage.objects/storage.buckets here; those statements require table ownership.
-- Supabase storage RLS is already enabled in managed projects.

DROP POLICY IF EXISTS "admin_users_view_child_docs_objects" ON storage.objects;
CREATE POLICY "admin_users_view_child_docs_objects"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id IN ('birth-certificates', 'signed-agreements')
  AND auth.uid() IN (
    'be89ac8b-d6ed-4cc2-a314-8c6fe34d2a68'::uuid,
    '2511df6b-e0a5-489e-8614-c74cf7d48cb4'::uuid,
    'b215eb9a-4017-45f1-a460-6056b1db0c4d'::uuid,
    '3401d428-4ed7-4ba1-ae64-4bd16d2485a4'::uuid,
    'a8d225b4-9f1a-45e0-8dc4-8ecdc7789e3c'::uuid,
    '41523b8c-3f3e-48c4-ba08-0e0a931156cd'::uuid
  )
);

DROP POLICY IF EXISTS "admin_users_view_child_docs_buckets" ON storage.buckets;
CREATE POLICY "admin_users_view_child_docs_buckets"
ON storage.buckets
FOR SELECT
TO authenticated
USING (
  id IN ('birth-certificates', 'signed-agreements')
  AND auth.uid() IN (
    'be89ac8b-d6ed-4cc2-a314-8c6fe34d2a68'::uuid,
    '2511df6b-e0a5-489e-8614-c74cf7d48cb4'::uuid,
    'b215eb9a-4017-45f1-a460-6056b1db0c4d'::uuid,
    '3401d428-4ed7-4ba1-ae64-4bd16d2485a4'::uuid,
    'a8d225b4-9f1a-45e0-8dc4-8ecdc7789e3c'::uuid,
    '41523b8c-3f3e-48c4-ba08-0e0a931156cd'::uuid
  )
);
