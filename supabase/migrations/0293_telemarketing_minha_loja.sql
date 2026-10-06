-- Telemarketing (mig 0292): ao abrir a tela, a atendente só RETOMA a loja que já
-- tem na mão. Pegar uma loja nova é só no botão "Próxima loja" (tm_pegar_proximo).
-- Antes a tela chamava tm_pegar_proximo ao abrir e travava uma loja sem ela pedir.

create or replace function public.tm_minha_loja()
returns setof public.tm_leads
language sql stable security definer set search_path = public as $$
  select l.*
  from tm_leads l
  where l.atendente_id = auth.uid()
    and l.pego_em > now() - interval '30 minutes'
    and exists (select 1 from tm_atendentes where user_id = auth.uid() and ativo)
  order by l.pego_em desc
  limit 1
$$;

revoke all on function public.tm_minha_loja() from public, anon;
grant execute on function public.tm_minha_loja() to authenticated;
