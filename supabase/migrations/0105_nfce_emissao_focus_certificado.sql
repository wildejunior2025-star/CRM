-- =========================================================
-- Migration 0105 - NFC-e: emissão via Focus + upload do certificado A1
-- =========================================================
-- 100% aditivo. Deixa o sistema pronto pra loja subir o A1 e emitir NFC-e:
--   * empresa_fiscal ganha o estado do registro no emissor (Focus) e os dados
--     do certificado (nome/validade já existente).
--   * nfce_notas ganha a ref (idempotência no Focus) e o QR Code.
--   * bucket PRIVADO `certificados-fiscais` guarda o .pfx de cada loja, com
--     RLS por empresa_id (a edge lê via service role).
-- =========================================================

alter table empresa_fiscal
  add column if not exists focus_registrada    boolean     not null default false,
  add column if not exists focus_registrada_em timestamptz,
  add column if not exists certificado_nome    text,
  add column if not exists ultimo_erro_fiscal  text;

alter table nfce_notas
  add column if not exists ref        text,
  add column if not exists qrcode_url text;

create index if not exists idx_nfce_notas_ref on nfce_notas(ref) where ref is not null;

insert into storage.buckets (id, name, public)
values ('certificados-fiscais', 'certificados-fiscais', false)
on conflict (id) do nothing;

drop policy if exists "Admin gerencia certificado da propria empresa" on storage.objects;
create policy "Admin gerencia certificado da propria empresa"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'certificados-fiscais'
    and current_perfil() = 'admin'
    and (storage.foldername(name))[1] = current_empresa_id()::text
  )
  with check (
    bucket_id = 'certificados-fiscais'
    and current_perfil() = 'admin'
    and (storage.foldername(name))[1] = current_empresa_id()::text
  );

drop policy if exists "Super admin gerencia certificados" on storage.objects;
create policy "Super admin gerencia certificados"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'certificados-fiscais' and current_perfil() = 'super_admin')
  with check (bucket_id = 'certificados-fiscais' and current_perfil() = 'super_admin');
