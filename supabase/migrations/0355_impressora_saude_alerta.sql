-- Saude das impressoras das lojas + aviso no WhatsApp do dono da FWC (20/10/2026)
--
-- POR QUE EXISTE
-- Em 20/10, na hora do movimento, a termica da cozinha do Braseiro parou de
-- receber. O Windows aceitava cada cupom, respondia OK e empilhava: 18 pedidos
-- presos na fila, nenhum papel. Ninguem soube ate o dono reclamar, e o conserto
-- em si levou 10 segundos (desligar e ligar a impressora). A hora perdida foi
-- toda no DIAGNOSTICO.
--
-- O app Impressora FWC ja roda em todas as lojas e ja sabia disso as 19:10 —
-- so nao tinha pra quem contar. Esta migracao da o ouvido.
--
-- PRA QUEM VAI O AVISO
-- Pro WhatsApp do dono da FWC, nao pra loja: a loja nao sabe resolver e ia
-- ligar pra ele de qualquer jeito. Mesmo cano do alerta de saude do banco
-- (mig 0281): instancia `admin_sender_instance` da Evolution -> numero em
-- `aviso_fwc_destino`.

-- ── o que cada PC reporta ───────────────────────────────────────────────────
create table if not exists public.impressora_saude (
  empresa_id uuid        not null references public.empresas(id) on delete cascade,
  pc         text        not null,                 -- nome da maquina (ha loja com 2)
  versao     int,
  logado     boolean     not null default true,
  pausado    boolean     not null default false,
  setor      text,                                 -- cozinha / frente / tudo
  -- [{nome, papel: 'cozinha'|'bar', presos: int, idade_min: int, offline: bool}]
  filas      jsonb       not null default '[]'::jsonb,
  visto_em   timestamptz not null default now(),
  primary key (empresa_id, pc)
);

alter table public.impressora_saude enable row level security;

-- O proprio PC da loja escreve a linha dele.
drop policy if exists "PC da loja cuida da propria saude" on public.impressora_saude;
create policy "PC da loja cuida da propria saude"
  on public.impressora_saude for all
  using      (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

-- O super admin ve todas (e escreve quando o app esta logado na conta dele,
-- que e o caso de quem cuida de varias lojas).
drop policy if exists "Super admin ve a saude das impressoras" on public.impressora_saude;
create policy "Super admin ve a saude das impressoras"
  on public.impressora_saude for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- ── um problema por vez, pra nao repetir aviso ──────────────────────────────
-- Sem isto o cron de 10 em 10 min mandaria a mesma mensagem seis vezes por hora
-- e o aviso viraria ruido — que e o mesmo que nao existir.
create table if not exists public.impressora_incidente (
  id             bigserial primary key,
  empresa_id     uuid not null references public.empresas(id) on delete cascade,
  pc             text not null,
  impressora     text not null default '',   -- vazio no caso 'mudo' (e o PC todo)
  tipo           text not null check (tipo in ('fila', 'mudo')),
  detalhe        text,
  aberto_em      timestamptz not null default now(),
  avisado_em     timestamptz,
  fechado_em     timestamptz,
  avisado_fim_em timestamptz
);

-- Um aberto por impressora/tipo. O indice parcial e o que o ON CONFLICT usa.
create unique index if not exists impressora_incidente_um_aberto
  on public.impressora_incidente (empresa_id, pc, impressora, tipo)
  where fechado_em is null;

create index if not exists impressora_incidente_recentes
  on public.impressora_incidente (aberto_em desc);

alter table public.impressora_incidente enable row level security;

drop policy if exists "Super admin ve os incidentes de impressora" on public.impressora_incidente;
create policy "Super admin ve os incidentes de impressora"
  on public.impressora_incidente for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- ── a decisao mora aqui, junto dos dados que ela julga ──────────────────────
-- A edge function so pergunta "tem o que mandar?" e manda. Assim a regra nao
-- se divide em dois lugares que um dia discordam.
create or replace function public.impressora_saude_avisar()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msgs     jsonb := '[]'::jsonb;
  v_telefone text;
  r          record;
begin
  -- 1. ABRE: fila entupida.
  --    2 presos ja bastam — numa termica de pedido, dois cupons parados por 5
  --    minutos nunca e normal (cupom sai em segundos). Esperar mais seria
  --    esperar o cliente reclamar.
  for r in
    select s.empresa_id, s.pc, e.nome as loja,
           f->>'nome' as impressora,
           coalesce((f->>'presos')::int, 0)    as presos,
           coalesce((f->>'idade_min')::int, 0) as idade_min,
           coalesce(f->>'papel', '')           as papel
      from impressora_saude s
      join empresas e on e.id = s.empresa_id
      cross join lateral jsonb_array_elements(s.filas) f
     where s.visto_em > now() - interval '30 minutes'
       and coalesce((f->>'presos')::int, 0)    >= 2
       and coalesce((f->>'idade_min')::int, 0) >= 5
  loop
    insert into impressora_incidente (empresa_id, pc, impressora, tipo, detalhe)
    values (r.empresa_id, r.pc, r.impressora, 'fila',
            r.presos || ' presos ha ' || r.idade_min || ' min'
            || case when r.papel <> '' then ' (' || r.papel || ')' else '' end)
    on conflict (empresa_id, pc, impressora, tipo) where fechado_em is null
    do update set detalhe = excluded.detalhe;
  end loop;

  -- 2. FECHA: a fila esvaziou (ou o PC sumiu — nesse caso o 'mudo' assume).
  update impressora_incidente i
     set fechado_em = now()
   where i.tipo = 'fila'
     and i.fechado_em is null
     and not exists (
       select 1
         from impressora_saude s
         cross join lateral jsonb_array_elements(s.filas) f
        where s.empresa_id = i.empresa_id
          and s.pc = i.pc
          and f->>'nome' = i.impressora
          and s.visto_em > now() - interval '30 minutes'
          and coalesce((f->>'presos')::int, 0)    >= 2
          and coalesce((f->>'idade_min')::int, 0) >= 5
     );

  -- 3. ABRE: o PC calou a boca ENQUANTO a loja vendia.
  --    A condicao de venda recente e o que impede o alerta de tocar de
  --    madrugada toda vez que alguem desliga o computador ao fechar.
  for r in
    select s.empresa_id, s.pc, e.nome as loja,
           round(extract(epoch from (now() - s.visto_em)) / 60)::int as calado_min
      from impressora_saude s
      join empresas e on e.id = s.empresa_id
     where s.visto_em < now() - interval '25 minutes'
       and (
         exists (select 1 from comanda_itens c
                  where c.empresa_id = s.empresa_id
                    and c.created_at > now() - interval '45 minutes')
         or exists (select 1 from pedidos_delivery p
                     where p.empresa_id = s.empresa_id
                       and p.created_at > now() - interval '45 minutes')
       )
  loop
    insert into impressora_incidente (empresa_id, pc, impressora, tipo, detalhe)
    values (r.empresa_id, r.pc, '', 'mudo', 'sem noticia ha ' || r.calado_min || ' min')
    on conflict (empresa_id, pc, impressora, tipo) where fechado_em is null
    do update set detalhe = excluded.detalhe;
  end loop;

  -- 4. FECHA: voltou a dar noticia.
  update impressora_incidente i
     set fechado_em = now()
   where i.tipo = 'mudo'
     and i.fechado_em is null
     and exists (
       select 1 from impressora_saude s
        where s.empresa_id = i.empresa_id
          and s.pc = i.pc
          and s.visto_em > now() - interval '25 minutes'
     );

  -- 5. Problemas que ainda nao foram avisados.
  with novos as (
    update impressora_incidente i
       set avisado_em = now()
      from empresas e
     where e.id = i.empresa_id
       and i.fechado_em is null
       and i.avisado_em is null
    returning i.tipo, i.pc, i.impressora, i.detalhe, e.nome as loja
  )
  select v_msgs || coalesce(jsonb_agg(
           case when n.tipo = 'fila' then
             '🖨️ *Impressora travada*' || chr(10) || chr(10) ||
             'Loja: ' || n.loja || chr(10) ||
             'Impressora: ' || n.impressora || chr(10) ||
             n.detalhe || chr(10) || chr(10) ||
             'O pedido NAO esta saindo.' || chr(10) ||
             'Na loja: desligar e ligar a impressora no botao.'
           else
             '🔌 *Impressora FWC sem resposta*' || chr(10) || chr(10) ||
             'Loja: ' || n.loja || chr(10) ||
             'PC: ' || n.pc || chr(10) ||
             n.detalhe || ', e a loja esta vendendo.' || chr(10) || chr(10) ||
             'Pode ser o app fechado, o PC desligado ou a internet.'
           end
         ), '[]'::jsonb)
    into v_msgs
    from novos n;

  -- 6. Problemas que se resolveram e ainda nao tiveram o "passou".
  --    Sem o aviso de alivio ele ficaria com o problema aberto na cabeca sem
  --    saber que ja acabou — e um dia iria ate a loja a toa.
  with fim as (
    update impressora_incidente i
       set avisado_fim_em = now()
      from empresas e
     where e.id = i.empresa_id
       and i.fechado_em is not null
       and i.avisado_em is not null
       and i.avisado_fim_em is null
    returning i.tipo, i.impressora, e.nome as loja,
              round(extract(epoch from (i.fechado_em - i.aberto_em)) / 60)::int as durou
  )
  select v_msgs || coalesce(jsonb_agg(
           '✅ *Voltou ao normal*' || chr(10) || chr(10) ||
           f.loja || case when f.impressora <> '' then ' · ' || f.impressora else '' end ||
           chr(10) || 'Ficou ' || f.durou || ' min com problema.'
         ), '[]'::jsonb)
    into v_msgs
    from fim f;

  select valor into v_telefone from config_global where chave = 'aviso_fwc_destino';
  if v_telefone is null then
    select valor into v_telefone from config_global where chave = 'saude_alerta_phone';
  end if;

  return jsonb_build_object(
    'telefone',  v_telefone,
    'mensagens', v_msgs
  );
end;
$$;

revoke all on function public.impressora_saude_avisar() from public, anon, authenticated;

comment on function public.impressora_saude_avisar() is
  'Abre/fecha incidentes de impressora e devolve o que ainda nao foi avisado. So a edge function (service role) chama.';

-- ── o gatilho ───────────────────────────────────────────────────────────────
-- 5 em 5 minutos: o custo e uma consulta curta, e a diferenca entre saber em 5
-- ou em 10 minutos, no meio do movimento, e uma fila de cliente esperando.
-- A edge function vai com --no-verify-jwt: o cron nao carrega JWT e levaria 401
-- calado (ver reference_edge_verify_jwt).
select cron.unschedule('impressora-alerta')
 where exists (select 1 from cron.job where jobname = 'impressora-alerta');

select cron.schedule(
  'impressora-alerta',
  '*/5 * * * *',
  $cron$ select net.http_post(
       url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/impressora-alerta',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body    := '{}'::jsonb
     ); $cron$
);
