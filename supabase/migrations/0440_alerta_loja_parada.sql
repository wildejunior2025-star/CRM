-- Aviso de LOJA PARADA no WhatsApp do dono da FWC (06/11/2026).
--
-- Wilde foi cobrar o Braseiro Trailer e descobriu na hora que a loja nao usava
-- o sistema ha 9 dias. Nada avisava. Aqui o banco olha todo dia e manda uma
-- mensagem so com as lojas que ficaram dias sem movimento.
--
-- "Movimento" = ultimo pedido (delivery/balcao/cardapio) OU ultima comanda de
-- mesa. So delivery enganava: Estacao e Saidera rodam mesa todo dia e pareciam
-- paradas.
--
-- Fica de fora quem o dono mandou nao avisar (empresas.alerta_parada_off):
-- loja cancelada, loja de teste/demo e a Academia (usa reconhecimento facial,
-- nao pedido nem comanda).

alter table public.empresas
  add column if not exists alerta_parada_off boolean not null default false,
  add column if not exists alerta_parada_em  timestamptz;

comment on column public.empresas.alerta_parada_off is
  'true = nao avisar o dono quando esta loja ficar parada (cancelada, teste, demo).';
comment on column public.empresas.alerta_parada_em is
  'Quando a loja foi citada no ultimo aviso de parada. Zera quando ela volta a usar.';

update public.empresas set alerta_parada_off = true
 where id in (
   'f1aaed32-3542-4f3a-abc3-6da3a90e5b8b',  -- Mickey Burguer (cancelou)
   '31173e2f-7e3d-437b-ae41-43e3fc2cc5e7',  -- CL Pescados (cancelou)
   'cb988843-287f-40b5-9e11-72f79b6f44da',  -- deposito de Thiago (teste)
   'e12b4527-5189-4fcc-9f4b-0d57c8ff29a9',  -- Pizzaria do Ze (demo)
   '1e3600f4-6870-474a-a212-15bca5198bfd'   -- Academia Vieira Raca (facial)
 );

-- Academia: a cobranca comeca em 05/12/2026, nao em 05/11. A de 05/11 ja tinha
-- sido gerada (R$ 100, aberta) e ia travar a loja em poucos dias.
update public.mensalidade_cobrancas
   set status = 'cancelada',
       observacao = coalesce(observacao || ' | ', '') || '06/11: cobranca comeca so em 05/12/2026'
 where empresa_id = '1e3600f4-6870-474a-a212-15bca5198bfd'
   and vencimento = date '2026-11-05'
   and status = 'aberta';

update public.mensalidade_config
   set inicio = date '2026-12-05',
       observacao = 'R$ 100 por mes, todo dia 5, a partir de 05/12/2026 (combinado 06/11)'
 where empresa_id = '1e3600f4-6870-474a-a212-15bca5198bfd';

-- Decide quem esta parado e monta o texto. Devolve so o que ainda nao foi
-- avisado (cada loja volta a ser citada depois de 7 dias parada).
create or replace function public.lojas_paradas_avisar(
  p_dias   int     default 3,
  p_forcar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel     text;
  v_linhas  text[] := '{}';
  v_ids     uuid[] := '{}';
  r         record;
  v_dias    int;
  v_lim     int;
  v_uteis   int;
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_tipicos int[];
begin
  select regexp_replace(valor, '\D', '', 'g') into v_tel
    from config_global where chave = 'aviso_fwc_destino';

  for r in
    select e.id, e.nome, e.created_at, e.alerta_parada_em,
           greatest(
             (select max(created_at) from pedidos_delivery where empresa_id = e.id),
             (select max(created_at) from comandas         where empresa_id = e.id)
           ) as ultimo,
           least(
             (select min(created_at) from pedidos_delivery where empresa_id = e.id),
             (select min(created_at) from comandas         where empresa_id = e.id)
           ) as primeiro
      from empresas e
     where e.status in ('ativo', 'trial')
       and not e.alerta_parada_off
     order by 5 nulls first, e.nome
  loop
    -- Loja que nunca teve movimento ainda nao foi ativada: nao avisa.
    if r.ultimo is null then continue; end if;

    v_dias := floor(extract(epoch from (now() - r.ultimo)) / 86400);

    -- DIAS EM QUE A LOJA COSTUMA ABRIR (aprendido do historico, 35 dias).
    -- Loja que fecha de proposito (ex.: Marajo, so abre 4 dias) nao pode ser
    -- cobrada pelos dias de folga. Dia da semana "tipico" = teve movimento em
    -- 2+ datas diferentes (1+ se a loja e nova, com menos de 14 dias de uso).
    select array_agg(dow) into v_tipicos from (
      select extract(dow from d)::int as dow
        from (
          select (created_at at time zone 'America/Sao_Paulo')::date as d
            from pedidos_delivery where empresa_id = r.id and created_at > now() - interval '35 days'
          union all
          select (created_at at time zone 'America/Sao_Paulo')::date
            from comandas where empresa_id = r.id and created_at > now() - interval '35 days'
        ) x
       group by 1
      having count(distinct d) >= case when r.primeiro > now() - interval '14 days' then 1 else 2 end
    ) t;

    -- Dias ABERTOS que passaram sem movimento (hoje nao conta: o aviso sai de manha).
    select count(*) into v_uteis
      from generate_series(
             (r.ultimo at time zone 'America/Sao_Paulo')::date + 1, v_hoje - 1, interval '1 day'
           ) g(d)
     where v_tipicos is null or extract(dow from g.d)::int = any(v_tipicos);

    -- Loja nova (menos de 30 dias de uso) ainda esta criando o habito: 1 dia
    -- aberto sem uso ja e risco (concorrente liga e leva). Antiga: p_dias-1.
    v_lim := case when r.primeiro > now() - interval '30 days' then 1
                  else greatest(p_dias - 1, 1) end;

    if v_uteis < v_lim then
      if r.alerta_parada_em is not null then
        update empresas set alerta_parada_em = null where id = r.id;
      end if;
      continue;
    end if;

    if not p_forcar and r.alerta_parada_em is not null
       and r.alerta_parada_em > now() - interval '7 days' then
      continue;
    end if;

    v_ids := v_ids || r.id;
    v_linhas := v_linhas || (
      '• *' || btrim(r.nome) || '* — sem movimento ha ' || v_dias || ' dias (ultimo: ' ||
      to_char(r.ultimo at time zone 'America/Sao_Paulo', 'DD/MM') || ')' ||
      case when v_uteis < v_dias then ' — ' || v_uteis || ' dia(s) aberto(s) sem uso' else '' end
    );
  end loop;

  if array_length(v_linhas, 1) is null then
    return jsonb_build_object('telefone', v_tel, 'mensagens', '[]'::jsonb);
  end if;

  if not p_forcar then
    update empresas set alerta_parada_em = now() where id = any(v_ids);
  end if;

  return jsonb_build_object(
    'telefone', v_tel,
    'mensagens', jsonb_build_array(
      '⚠️ *Lojas paradas*' || E'\n\n' || array_to_string(v_linhas, E'\n') ||
      E'\n\n_Conta pedido, venda de balcao e comanda de mesa, so nos dias em que a loja costuma abrir._'
    )
  );
end;
$$;

revoke all on function public.lojas_paradas_avisar(int, boolean) from public, anon, authenticated;

-- Todo dia as 9h (Brasilia). A edge vai com --no-verify-jwt: cron nao leva JWT.
select cron.unschedule('loja-parada-alerta')
 where exists (select 1 from cron.job where jobname = 'loja-parada-alerta');

select cron.schedule(
  'loja-parada-alerta',
  '0 12 * * *',
  $cron$ select net.http_post(
       url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/loja-parada-alerta',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body    := '{}'::jsonb
     ); $cron$
);
