-- Telemarketing da FWC (rota /ligacoes): atendentes ligam pra lojas, preenchem as
-- respostas e o lead já chega qualificado pro dono. É um bloco ISOLADO (tudo com
-- prefixo tm_): não mexe em profiles nem em nada das lojas. Se não ficar bom, é só
-- apagar as tabelas/funções tm_* e a rota, sem afetar o sistema.
--
-- Atendente = usuário do Auth + linha em tm_atendentes (SEM profile). Quem trava a
-- loja é quem clica primeiro em "Próxima loja" (tm_pegar_proximo, com skip locked);
-- a loja some pro resto da fila. Trava solta sozinha em 30 min se a pessoa sumir.

create table if not exists public.tm_atendentes (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  nome      text not null,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists public.tm_leads (
  id           uuid primary key default gen_random_uuid(),
  chave        text not null unique,             -- loja normalizada + telefone (evita duplicar na importação)
  loja         text not null,
  telefone     text,
  tipo         text,
  bairro       text,
  cidade       text,
  endereco     text,
  nota         numeric,
  avaliacoes   integer,
  site         text,
  link_maps    text,
  cnpj         text,
  razao_social text,
  nome_dono    text,
  status       text not null default 'novo'
               check (status in ('novo','retornar','visita','visitado','fechou','sem_interesse','sem_contato','numero_errado')),
  temperatura  text check (temperatura in ('quente','morno','frio')),
  tentativas   integer not null default 0,
  -- trava de quem está ligando agora
  atendente_id uuid references public.tm_atendentes(user_id) on delete set null,
  pego_em      timestamptz,
  -- só entra na fila de novo a partir daqui (retorno combinado / nova tentativa)
  proxima_em   timestamptz,
  -- resumo das últimas respostas (o histórico completo fica em tm_ligacoes)
  usa_sistema        boolean,
  qual_sistema       text,
  vende_ifood        boolean,
  quem_atende        text,
  quem_atende_nome   text,
  entregador_proprio boolean,
  melhor_horario     text,
  visita_em    timestamptz,
  visita_quem  text,
  motivo_nao   text,
  ultimo_atendente_id uuid references public.tm_atendentes(user_id) on delete set null,
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists tm_leads_fila_idx on public.tm_leads (status, proxima_em) where atendente_id is null;
create index if not exists tm_leads_visita_idx on public.tm_leads (visita_em) where status = 'visita';

create table if not exists public.tm_ligacoes (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.tm_leads(id) on delete cascade,
  atendente_id uuid references public.tm_atendentes(user_id) on delete set null,
  criado_em    timestamptz not null default now(),
  resultado    text not null check (resultado in ('atendeu','nao_atendeu','caixa_postal','numero_errado','dono_ausente')),
  usa_sistema        boolean,
  qual_sistema       text,
  vende_ifood        boolean,
  quem_atende        text,
  quem_atende_nome   text,
  entregador_proprio boolean,
  desfecho     text check (desfecho in ('visita','retornar','sem_interesse')),
  visita_em    timestamptz,
  visita_quem  text,
  retorno_em   timestamptz,
  motivo_nao   text,
  nome_dono    text,
  melhor_horario text,
  observacao   text
);

create index if not exists tm_ligacoes_lead_idx on public.tm_ligacoes (lead_id, criado_em desc);
create index if not exists tm_ligacoes_atendente_idx on public.tm_ligacoes (atendente_id, criado_em desc);

-- ── Quem é quem ───────────────────────────────────────────────────────────────
create or replace function public.tm_eh_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and perfil = 'super_admin')
$$;

create or replace function public.tm_eh_atendente()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tm_atendentes where user_id = auth.uid() and ativo)
$$;

-- ── RLS: atendente só enxerga a loja que ele travou; o dono enxerga tudo ──────
alter table public.tm_atendentes enable row level security;
alter table public.tm_leads      enable row level security;
alter table public.tm_ligacoes   enable row level security;

drop policy if exists tm_atendentes_admin on public.tm_atendentes;
create policy tm_atendentes_admin on public.tm_atendentes for all
  using (public.tm_eh_admin()) with check (public.tm_eh_admin());
drop policy if exists tm_atendentes_proprio on public.tm_atendentes;
create policy tm_atendentes_proprio on public.tm_atendentes for select
  using (user_id = auth.uid());

drop policy if exists tm_leads_admin on public.tm_leads;
create policy tm_leads_admin on public.tm_leads for all
  using (public.tm_eh_admin()) with check (public.tm_eh_admin());
drop policy if exists tm_leads_travado_meu on public.tm_leads;
create policy tm_leads_travado_meu on public.tm_leads for select
  using (atendente_id = auth.uid());

drop policy if exists tm_ligacoes_admin on public.tm_ligacoes;
create policy tm_ligacoes_admin on public.tm_ligacoes for all
  using (public.tm_eh_admin()) with check (public.tm_eh_admin());

-- ── Próxima loja: quem clica primeiro pega, e some pro resto ──────────────────
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

  -- Já está com uma loja na mão (e a trava está viva)? Devolve a mesma, assim
  -- atualizar a página não faz perder a loja.
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
   order by (status = 'retornar') desc, tentativas asc, cidade, bairro, loja
   for update skip locked
   limit 1;
  if not found then return; end if;

  update tm_leads set atendente_id = v_uid, pego_em = now(), atualizado_em = now()
   where id = v.id
   returning * into v;
  return next v;
end $$;

-- Devolve a loja pra fila sem contar tentativa (atendente desistiu / não quis ligar).
create or replace function public.tm_liberar(p_lead uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update tm_leads set atendente_id = null, pego_em = null, atualizado_em = now()
   where id = p_lead and atendente_id = auth.uid();
end $$;

-- ── Registrar a ligação ───────────────────────────────────────────────────────
create or replace function public.tm_registrar_ligacao(p_lead uuid, p_dados jsonb)
returns public.tm_leads
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  l       public.tm_leads;
  v_res   text := p_dados->>'resultado';
  v_desf  text := nullif(p_dados->>'desfecho', '');
  v_tent  integer;
  v_status text;
  v_temp  text;
  v_prox  timestamptz;
  v_visita timestamptz := nullif(p_dados->>'visita_em', '')::timestamptz;
  v_retorno timestamptz := nullif(p_dados->>'retorno_em', '')::timestamptz;
  v_usa   boolean := (p_dados->>'usa_sistema')::boolean;
  v_ifood boolean := (p_dados->>'vende_ifood')::boolean;
begin
  if not exists (select 1 from tm_atendentes where user_id = v_uid and ativo) then
    raise exception 'Sem acesso';
  end if;
  select * into l from tm_leads where id = p_lead and atendente_id = v_uid for update;
  if not found then raise exception 'Essa loja não está mais com você'; end if;
  if v_res not in ('atendeu','nao_atendeu','caixa_postal','numero_errado','dono_ausente') then
    raise exception 'Resultado inválido';
  end if;

  v_tent := l.tentativas;
  v_status := l.status;
  v_temp := l.temperatura;

  if v_res = 'numero_errado' then
    v_status := 'numero_errado';
  elsif v_res in ('nao_atendeu', 'caixa_postal') then
    v_tent := v_tent + 1;
    v_status := case when v_tent >= 3 then 'sem_contato' else 'novo' end;
    v_prox := now() + interval '4 hours';
  elsif v_res = 'dono_ausente' then
    v_tent := v_tent + 1;
    v_status := case when v_tent >= 3 then 'sem_contato' else 'retornar' end;
    v_prox := now() + interval '4 hours';
  else -- atendeu
    if v_desf is null then raise exception 'Diga como terminou a conversa'; end if;
    if v_desf = 'visita' then
      if v_visita is null then raise exception 'Informe o dia e a hora da visita'; end if;
      v_status := 'visita'; v_temp := 'quente';
    elsif v_desf = 'retornar' then
      if v_retorno is null then raise exception 'Informe quando ligar de novo'; end if;
      v_status := 'retornar'; v_prox := v_retorno; v_temp := 'morno';
    else
      v_status := 'sem_interesse'; v_temp := 'frio';
    end if;
  end if;

  insert into tm_ligacoes (
    lead_id, atendente_id, resultado, usa_sistema, qual_sistema, vende_ifood,
    quem_atende, quem_atende_nome, entregador_proprio, desfecho, visita_em,
    visita_quem, retorno_em, motivo_nao, nome_dono, melhor_horario, observacao
  ) values (
    p_lead, v_uid, v_res, v_usa, nullif(p_dados->>'qual_sistema', ''), v_ifood,
    nullif(p_dados->>'quem_atende', ''), nullif(p_dados->>'quem_atende_nome', ''),
    (p_dados->>'entregador_proprio')::boolean,
    case when v_res = 'atendeu' then v_desf end,
    case when v_desf = 'visita' then v_visita end,
    nullif(p_dados->>'visita_quem', ''),
    case when v_desf = 'retornar' then v_retorno end,
    nullif(p_dados->>'motivo_nao', ''),
    nullif(p_dados->>'nome_dono', ''), nullif(p_dados->>'melhor_horario', ''),
    nullif(p_dados->>'observacao', '')
  );

  update tm_leads set
    status = v_status,
    temperatura = v_temp,
    tentativas = v_tent,
    proxima_em = v_prox,
    atendente_id = null,
    pego_em = null,
    ultimo_atendente_id = v_uid,
    usa_sistema = coalesce(v_usa, usa_sistema),
    qual_sistema = coalesce(nullif(p_dados->>'qual_sistema', ''), qual_sistema),
    vende_ifood = coalesce(v_ifood, vende_ifood),
    quem_atende = coalesce(nullif(p_dados->>'quem_atende', ''), quem_atende),
    quem_atende_nome = coalesce(nullif(p_dados->>'quem_atende_nome', ''), quem_atende_nome),
    entregador_proprio = coalesce((p_dados->>'entregador_proprio')::boolean, entregador_proprio),
    nome_dono = coalesce(nullif(p_dados->>'nome_dono', ''), nome_dono),
    melhor_horario = coalesce(nullif(p_dados->>'melhor_horario', ''), melhor_horario),
    visita_em = case when v_desf = 'visita' then v_visita else visita_em end,
    visita_quem = case when v_desf = 'visita' then nullif(p_dados->>'visita_quem', '') else visita_quem end,
    motivo_nao = case when v_desf = 'sem_interesse' then nullif(p_dados->>'motivo_nao', '') else motivo_nao end,
    atualizado_em = now()
  where id = p_lead
  returning * into l;

  return l;
end $$;

-- Resumo do dia do atendente (as 3 contas da tela dele).
create or replace function public.tm_meu_resumo()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ligacoes', count(*),
    'atendeu',  count(*) filter (where resultado = 'atendeu'),
    'visitas',  count(*) filter (where desfecho = 'visita')
  )
  from tm_ligacoes
  where atendente_id = auth.uid()
    and criado_em >= (date_trunc('day', now() at time zone 'America/Fortaleza') at time zone 'America/Fortaleza')
$$;

-- ── Aviso no WhatsApp do dono quando marcam visita ────────────────────────────
-- Mesmo caminho do aviso de pagamento (mig 0288): edge aviso-fwc-entrada entrega
-- pro config_global.aviso_fwc_destino.
create or replace function public.tm_avisar_visita()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_token text;
  v_lead  tm_leads;
  v_atend text;
  v_dia   text;
  v_texto text;
begin
  if new.desfecho is distinct from 'visita' then return new; end if;
  select valor into v_token from config_global where chave = 'aviso_fwc_token';
  if coalesce(v_token, '') = '' then return new; end if;
  select * into v_lead from tm_leads where id = new.lead_id;
  select nome into v_atend from tm_atendentes where user_id = new.atendente_id;

  v_dia := (array['domingo','segunda','terça','quarta','quinta','sexta','sábado'])
           [extract(dow from new.visita_em at time zone 'America/Fortaleza')::int + 1];

  v_texto := '📅 *Visita marcada*' || chr(10) || chr(10)
    || '*' || v_lead.loja || '*' || chr(10)
    || '🕒 ' || v_dia || ', ' || to_char(new.visita_em at time zone 'America/Fortaleza', 'DD/MM "às" HH24:MI') || chr(10)
    || '📍 ' || coalesce(v_lead.endereco, '—') || chr(10)
    || '📞 ' || coalesce(v_lead.telefone, '—') || chr(10)
    || case when coalesce(new.visita_quem, v_lead.nome_dono, '') <> ''
            then '👤 Falar com: ' || coalesce(new.visita_quem, v_lead.nome_dono) || chr(10) else '' end
    || '🧾 Sistema: ' || case v_lead.usa_sistema when true then coalesce(v_lead.qual_sistema, 'sim') when false then 'não usa' else '—' end
    || ' · iFood: ' || case v_lead.vende_ifood when true then 'sim' when false then 'não' else '—' end || chr(10)
    || case when coalesce(new.observacao, '') <> '' then '📝 ' || new.observacao || chr(10) else '' end
    || case when coalesce(v_lead.link_maps, '') <> '' then '🗺 ' || v_lead.link_maps || chr(10) else '' end
    || 'Marcado por ' || coalesce(v_atend, 'atendente');

  perform net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/aviso-fwc-entrada?token=' || v_token,
    body := jsonb_build_object('aviso', v_texto),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  return new;
exception when others then
  -- O aviso é bônus: nunca pode travar o registro da ligação.
  return new;
end $$;

drop trigger if exists trg_tm_avisar_visita on public.tm_ligacoes;
create trigger trg_tm_avisar_visita
  after insert on public.tm_ligacoes
  for each row execute function public.tm_avisar_visita();

-- ── Permissões ────────────────────────────────────────────────────────────────
revoke all on function public.tm_pegar_proximo() from public, anon;
revoke all on function public.tm_liberar(uuid) from public, anon;
revoke all on function public.tm_registrar_ligacao(uuid, jsonb) from public, anon;
revoke all on function public.tm_meu_resumo() from public, anon;
revoke all on function public.tm_eh_admin() from public, anon;
revoke all on function public.tm_eh_atendente() from public, anon;
revoke all on function public.tm_avisar_visita() from public, anon, authenticated;
grant execute on function public.tm_pegar_proximo() to authenticated;
grant execute on function public.tm_liberar(uuid) to authenticated;
grant execute on function public.tm_registrar_ligacao(uuid, jsonb) to authenticated;
grant execute on function public.tm_meu_resumo() to authenticated;
grant execute on function public.tm_eh_admin() to authenticated;
grant execute on function public.tm_eh_atendente() to authenticated;
