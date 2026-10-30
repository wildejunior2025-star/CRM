-- CÓDIGO DE LIBERAÇÃO NO WHATSAPP DO DONO (30/10/2026)
--
-- Pedido do dono: quando o caixa não bate, a mensagem dele já traz um código de
-- 4 dígitos. Ele passa o número pro vendedor, o vendedor digita na tela e o
-- caixa fecha. Assim o dono não precisa entrar no sistema e redigitar valor
-- nenhum — decide pelo WhatsApp mesmo, que é onde ele já está.
--
-- A liberação por código vai na MESMA porta que o `liberar_fechamento_caixa`
-- já usa (liberado_em / liberado_por). Muda só quem pode abrir: antes era só o
-- admin logado; agora é também quem sabe o código daquele caixa.
--
-- AS TRAVAS, E POR QUE CADA UMA
--   • 30 minutos de validade — tempo de ler o zap e passar pro vendedor. Sem
--     prazo, o código vira chave permanente de quem viu a mensagem.
--   • Uma vez só — some assim que usado. Sem isso o vendedor decora o número e
--     fecha sozinho pra sempre, e o caixa cego vira enfeite.
--   • Muda a cada "não bateu" — cada tentativa sorteia outro.
--   • 5 erros e morre — 4 dígitos são 10 mil combinações; sem limite de
--     tentativa dava pra chutar.
--
-- ONDE O CÓDIGO MORA
-- Numa tabela à parte, com RLS ligada e NENHUMA policy: o PostgREST não
-- devolve linha nenhuma dela pra ninguém. Só as funções SECURITY DEFINER
-- daqui enxergam. Se ficasse numa coluna de `caixas`, o próprio app do
-- vendedor leria o código ao carregar a tela do caixa.

-- ── 1. Onde fica o código ───────────────────────────────────────────────────
create table if not exists public.caixa_liberacao (
  caixa_id   uuid primary key references public.caixas(id) on delete cascade,
  codigo     text        not null,
  expira_em  timestamptz not null,
  erros      smallint    not null default 0,
  criado_em  timestamptz not null default now()
);

alter table public.caixa_liberacao enable row level security;
revoke all on table public.caixa_liberacao from anon, authenticated;

comment on table public.caixa_liberacao is
  'Código de 4 dígitos que o dono recebe no WhatsApp e passa pro vendedor fechar um caixa que não bateu. Sem policy de propósito: ninguém lê pelo app, só as funções SECURITY DEFINER.';

alter table public.caixas
  add column if not exists liberado_por_codigo boolean not null default false;

comment on column public.caixas.liberado_por_codigo is
  'true = o fechamento foi liberado por código passado no WhatsApp, não pelo dono logado. Fica no histórico pra depois dar pra saber como aquele caixa foi autorizado.';

-- ── 2. Quem erra demais perde o código ──────────────────────────────────────
-- Separado pra `liberar_fechamento_por_codigo` poder gravar a tentativa errada
-- mesmo sendo chamada de dentro de uma transação que vai dar raise.
create or replace function public.caixa_codigo_errou(p_caixa_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update caixa_liberacao set erros = erros + 1 where caixa_id = p_caixa_id;
  delete from caixa_liberacao where caixa_id = p_caixa_id and erros >= 5;
end;
$$;

revoke all on function public.caixa_codigo_errou(uuid) from public, anon, authenticated;

-- ── 3. O vendedor digita o código ───────────────────────────────────────────
create or replace function public.liberar_fechamento_por_codigo(
  p_caixa_id uuid,
  p_codigo   text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lib caixa_liberacao%rowtype;
  v_cod text := regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g');
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão';
  end if;

  -- O caixa tem que ser desta loja, estar aberto, e ser o que a pessoa abriu
  -- (ou ela ser admin). A mesma regra do pedir_liberacao_fechamento.
  if not exists (
    select 1 from caixas
    where id = p_caixa_id
      and empresa_id = current_empresa_id()
      and status = 'aberto'
      and (aberto_por = auth.uid() or current_perfil() = 'admin')
  ) then
    raise exception 'Caixa não encontrado ou já fechado';
  end if;

  select * into v_lib from caixa_liberacao where caixa_id = p_caixa_id;

  if v_lib.caixa_id is null then
    raise exception 'CODIGO_INVALIDO';
  end if;

  if v_lib.expira_em < now() then
    delete from caixa_liberacao where caixa_id = p_caixa_id;
    raise exception 'CODIGO_EXPIRADO';
  end if;

  if v_lib.codigo <> v_cod then
    perform caixa_codigo_errou(p_caixa_id);
    raise exception 'CODIGO_INVALIDO';
  end if;

  update caixas
  set liberado_em = now(),
      liberado_por = auth.uid(),
      liberado_por_codigo = true
  where id = p_caixa_id;

  -- Uma vez só.
  delete from caixa_liberacao where caixa_id = p_caixa_id;
end;
$$;

revoke all on function public.liberar_fechamento_por_codigo(uuid, text) from public, anon;
grant execute on function public.liberar_fechamento_por_codigo(uuid, text) to authenticated;

-- ── 4. Sortear o código junto com o aviso ───────────────────────────────────
-- Igual à versão do 0432, com o sorteio no fim. O código nasce DEPOIS da trava
-- de 10 minutos: tentativa repetida não gera código novo, e o que já foi pro
-- WhatsApp do dono continua valendo.
create or replace function public.registrar_nao_bateu(
  p_caixa_id uuid,
  p_dinheiro numeric,
  p_pix numeric,
  p_cartao numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c caixas%rowtype;
  e record;
  f jsonb := '{}'::jsonb;
  t jsonb;
  v_cod text;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão';
  end if;

  select * into c from caixas
  where id = p_caixa_id and empresa_id = current_empresa_id()
    and status = 'aberto' and aberto_por = auth.uid();
  if c.id is null then return; end if;

  if not coalesce((select caixa_cego from empresas where id = c.empresa_id), false) then
    return;
  end if;

  select * into e from caixa_esperado(p_caixa_id);
  t := jsonb_build_object(
    'dinheiro', jsonb_build_object('contado', coalesce(p_dinheiro, 0), 'esperado', coalesce(e.dinheiro, 0)),
    'pix',      jsonb_build_object('contado', coalesce(p_pix, 0),      'esperado', coalesce(e.pix, 0)),
    'cartao',   jsonb_build_object('contado', coalesce(p_cartao, 0),   'esperado', coalesce(e.cartao, 0))
  );
  if abs(coalesce(p_dinheiro, 0) - coalesce(e.dinheiro, 0)) > 0.011 then f := f || jsonb_build_object('dinheiro', t -> 'dinheiro'); end if;
  if abs(coalesce(p_pix, 0) - coalesce(e.pix, 0)) > 0.011 then f := f || jsonb_build_object('pix', t -> 'pix'); end if;
  if abs(coalesce(p_cartao, 0) - coalesce(e.cartao, 0)) > 0.101 then f := f || jsonb_build_object('cartao', t -> 'cartao'); end if;
  if f = '{}'::jsonb then return; end if;

  if c.ultima_tentativa is not null
     and (c.ultima_tentativa -> 'formas') = f
     and (c.ultima_tentativa ->> 'em')::timestamptz > now() - interval '10 minutes' then
    return;
  end if;

  update caixas
  set ultima_tentativa = jsonb_build_object('em', now(), 'por', auth.uid(), 'formas', f, 'todas', t),
      liberacao_pedida_em = now(),
      liberacao_pedida_por = auth.uid()
  where id = c.id;

  -- Código novo a cada aviso. O anterior morre aqui mesmo.
  v_cod := lpad((floor(random() * 10000))::int::text, 4, '0');
  insert into caixa_liberacao (caixa_id, codigo, expira_em, erros)
  values (c.id, v_cod, now() + interval '30 minutes', 0)
  on conflict (caixa_id) do update
    set codigo = excluded.codigo, expira_em = excluded.expira_em,
        erros = 0, criado_em = now();

  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/caixa-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('caixa_id', c.id, 'momento', 'nao_bateu'),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning '[caixa-aviso] nao consegui avisar: %', sqlerrm;
  end;
end;
$$;

-- ── 5. O código entra na mensagem ───────────────────────────────────────────
-- Igual à do 0432, com o bloco do código no fim.
create or replace function public.caixa_aviso_nao_bateu(
  c caixas, p_instancia text, p_fones text[], p_loja text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_quem   text;
  v_erra   text;
  v_bateu  text;
  v_texto  text;
  v_cod    text;
begin
  if c.ultima_tentativa is null then return null; end if;
  v_quem := estoque_quem_lancou(nullif(c.ultima_tentativa ->> 'por', '')::uuid);

  with f as (
    select k.key as forma,
           (k.value ->> 'contado')::numeric as contado,
           (k.value ->> 'esperado')::numeric as esperado,
           case k.key when 'dinheiro' then 1 when 'pix' then 2 else 3 end as ord,
           case k.key when 'dinheiro' then U&'\+01F4B5' || ' *Dinheiro*'
                      when 'pix'      then U&'\+01F4F1' || ' *PIX*'
                      else                 U&'\+01F4B3' || ' *Cartão (conta da maquineta)*' end as rotulo,
           (c.ultima_tentativa -> 'formas') ? k.key as errou
      from jsonb_each(coalesce(c.ultima_tentativa -> 'todas', c.ultima_tentativa -> 'formas')) k
  )
  select
    string_agg(
      rotulo || chr(10) ||
      '   contou ' || reais_br(contado) || ' · esperado ' || reais_br(esperado) || chr(10) ||
      '   ' || case when contado > esperado
                    then U&'\26A0\FE0F' || ' *sobrou ' || reais_br(contado - esperado) || '*'
                    else U&'\+01F6A8' || ' *faltou ' || reais_br(esperado - contado) || '*' end,
      chr(10) || chr(10) order by ord) filter (where errou),
    string_agg(
      U&'\2705' || ' ' || rotulo || ' — ' || reais_br(contado),
      chr(10) order by ord) filter (where not errou and (contado <> 0 or esperado <> 0))
    into v_erra, v_bateu
    from f;

  select codigo into v_cod from caixa_liberacao
  where caixa_id = c.id and expira_em > now();

  v_texto :=
    U&'\+01F7E0' || ' *Caixa não bateu* — ' || coalesce(p_loja, '') || chr(10) || chr(10) ||
    'Quem tentou fechar: *' || v_quem || '*' || chr(10) ||
    'Quando: ' || to_char((c.ultima_tentativa ->> 'em')::timestamptz at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
    chr(10) || chr(10) ||
    U&'\274C' || ' *NÃO BATEU*' || chr(10) || coalesce(v_erra, '—') ||
    case when v_bateu is not null
         then chr(10) || chr(10) || U&'\2705' || ' *BATEU*' || chr(10) || v_bateu else '' end ||
    chr(10) || chr(10) ||
    'O caixa *não foi fechado*.' ||
    case when v_cod is not null then
      chr(10) || chr(10) ||
      U&'\+01F511' || ' *Código de liberação: ' || v_cod || '*' || chr(10) ||
      '_Passe esse número pro vendedor SÓ se você concorda em fechar com essa diferença. ' ||
      'Vale 30 minutos e serve uma vez só._'
    else '' end ||
    chr(10) || chr(10) ||
    'Se preferir, feche pelo seu login (você pode fechar mesmo sem bater) ou toque em ' ||
    '*Liberar fechamento* na tela do Caixa.';

  return jsonb_build_object('instancia', p_instancia, 'telefone', p_fones[1], 'telefones', to_jsonb(p_fones), 'texto', v_texto);
end;
$$;
