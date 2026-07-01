-- Fix: SELECT do bucket empresa-banners estava só para anon.
-- O upload (storage-api) e o admin logado precisam ler de volta -> dava
-- 403 "new row violates row-level security policy" no upload de banner/logo.
-- Passa para public (o bucket é público mesmo).
drop policy if exists "empresa-banners: leitura publica" on storage.objects;
create policy "empresa-banners: leitura publica" on storage.objects
  for select to public using (bucket_id = 'empresa-banners');
