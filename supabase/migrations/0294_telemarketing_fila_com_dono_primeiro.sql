-- Telemarketing (mig 0292): a fila agora entrega primeiro as lojas que têm o nome do
-- dono (vindo do cadastro de CNPJ). Pedir pela pessoa pelo nome rende mais visita
-- que "falo com o responsável?", então as primeiras ligações já usam a melhor abertura.
-- Ordem: retorno combinado (a pessoa pediu pra ligar) > loja com nome do dono >
-- o resto; dentro de cada grupo, menos tentativas primeiro e por bairro (rota).

create or replace function public.tm_pegar_proximo()
returns setof public.tm_leads
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v     public.tm_leads;
begin
  if not exists (select 1 from tm_atendentes where user_id = v_uid and ativo) then
    raise exception 'Sem acesso';
  end if;

  -- Já está com uma loja na mão (e a trava está viva)? Devolve a mesma.
  select * into v from tm_leads
   where atendente_id = v_uid and pego_em > now() - interval '30 minutes'
   order by pego_em desc limit 1;
  if found then
    return next v;
    return;
  end if;

  select * into v from tm_leads
   where status in ('novo', 'retornar')
     and coalesce(telefone, '') <> ''
     and tentativas < 3
     and (proxima_em is null or proxima_em <= now())
     and (atendente_id is null or pego_em is null or pego_em < now() - interval '30 minutes')
   order by (status = 'retornar') desc,
            (coalesce(nome_dono, '') <> '') desc,
            tentativas asc, cidade, bairro, loja
   for update skip locked
   limit 1;
  if not found then return; end if;

  update tm_leads set atendente_id = v_uid, pego_em = now(), atualizado_em = now()
   where id = v.id
   returning * into v;
  return next v;
end $$;
