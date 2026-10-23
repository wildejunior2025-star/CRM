-- Aviso de ABERTURA e FECHAMENTO de caixa no WhatsApp do dono (23/10/2026)
--
-- POR QUE
-- Mesmo pedido do aviso de estoque: o dono nao fica na loja, e quem abre e
-- fecha o caixa e o funcionario. Em 20/10 o Braseiro fechou com R$ 322 na
-- gaveta contra R$ 289,48 esperados e ninguem viu — a diferenca so apareceu
-- porque o Wilde foi conferir na mao, no dia seguinte.
--
-- O QUE VAI NA MENSAGEM
-- Abertura: quem abriu e com quanto. Fechamento: quem fechou, quanto contou,
-- quanto era esperado e a DIFERENCA — que e a unica linha que faz o dono parar
-- e perguntar.
--
-- DINHEIRO E PIX TEM ESPERADO; CARTAO NAO.
-- A conta do cartao depende da taxa de cada maquininha (credito, debito e
-- generico tem taxas diferentes por loja). Chutar isso faria o dono cacar
-- todo dia uma diferenca que nao existe. Entao do cartao vai so o contado.

-- ── quem fechou ─────────────────────────────────────────────────────────────
-- `caixas` guardava quem ABRIU e nao quem FECHOU (so `caixa_dia` tinha, e
-- quase ninguem usa aquele caminho: 177 fechamentos pelo `caixas` contra 1).
-- Preenchido por gatilho, e nao pela tela, porque o fechamento passa pela RPC
-- `fechar_caixa` — assim vale pra qualquer caminho que feche o caixa.
alter table public.caixas add column if not exists fechado_por uuid references auth.users(id);

create or replace function public.caixa_marca_quem_fechou()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.fechado_em is not null and old.fechado_em is null and new.fechado_por is null then
    new.fechado_por := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists caixa_quem_fechou on public.caixas;
create trigger caixa_quem_fechou
  before update on public.caixas
  for each row execute function public.caixa_marca_quem_fechou();

-- ── liga/desliga por loja ───────────────────────────────────────────────────
-- Separado do aviso de estoque: sao dois assuntos, e uma loja pode querer so
-- um deles. Vai pro mesmo `admin_phone` e pelo mesmo zap.
alter table public.whatsapp_config
  add column if not exists notif_caixa boolean not null default false;

comment on column public.whatsapp_config.notif_caixa is
  'Avisa o admin_phone quando abrem e quando fecham o caixa, com quem foi e os valores.';

-- ── a mensagem ──────────────────────────────────────────────────────────────
create or replace function public.caixa_aviso(p_caixa_id uuid, p_momento text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c          caixas%rowtype;
  wc         record;
  v_loja     text;
  v_quem     text;
  v_texto    text;
  -- esperado
  din_rec numeric := 0; din_del numeric := 0; din_sup numeric := 0; din_san numeric := 0;
  pix_rec numeric := 0; pix_del numeric := 0; pix_sup numeric := 0; pix_san numeric := 0;
  esp_din numeric; esp_pix numeric; dif_din numeric; dif_pix numeric;
  v_horas text;
begin
  select * into c from caixas where id = p_caixa_id;
  if c.id is null then return null; end if;

  select wc2.admin_phone,
         coalesce(nullif(trim(wc2.instance_name), ''),
                  (select valor from config_global where chave = 'admin_sender_instance'),
                  'crmadmin') as instancia,
         wc2.notif_caixa
    into wc
    from whatsapp_config wc2 where wc2.empresa_id = c.empresa_id;

  if not coalesce(wc.notif_caixa, false) or coalesce(trim(wc.admin_phone), '') = '' then
    return null;
  end if;

  select nome into v_loja from empresas where id = c.empresa_id;
  v_quem := estoque_quem_lancou(case when p_momento = 'abertura' then c.aberto_por else c.fechado_por end);

  if p_momento = 'abertura' then
    v_texto :=
      U&'\+01F7E2' || ' *Caixa aberto* — ' || coalesce(v_loja, '') || chr(10) || chr(10) ||
      'Quem abriu: *' || v_quem || '*' || chr(10) ||
      'Quando: ' || to_char(c.aberto_em at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') || chr(10) || chr(10) ||
      U&'\+01F4B5' || ' Dinheiro na gaveta: *' || reais_br(c.valor_abertura) || '*' ||
      case when coalesce(c.valor_abertura_pix, 0) > 0
           then chr(10) || U&'\+01F4F1' || ' PIX: ' || reais_br(c.valor_abertura_pix) else '' end ||
      case when coalesce(c.valor_abertura_cartao, 0) > 0
           then chr(10) || U&'\+01F4B3' || ' Cartão: ' || reais_br(c.valor_abertura_cartao) else '' end ||
      case when coalesce(trim(c.observacoes_abertura), '') <> ''
           then chr(10) || chr(10) || U&'\+01F4DD' || ' ' || c.observacoes_abertura else '' end;

    return jsonb_build_object('instancia', wc.instancia, 'telefone', wc.admin_phone, 'texto', v_texto);
  end if;

  -- ── fechamento ────────────────────────────────────────────────────────────
  -- Mesma conta da tela do Caixa: abertura + o que entrou em dinheiro
  -- (balcão e delivery) + suprimentos − sangrias. iFood pago no app e PIX do
  -- checkout NAO entram: é faturamento, mas não passou pela gaveta.
  select coalesce(sum(valor) filter (where forma_pagamento = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where forma_pagamento = 'pix'), 0)
    into din_rec, pix_rec
    from pagamentos where caixa_id = c.id;

  select coalesce(sum(valor) filter (where bucket = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where bucket = 'pix'), 0)
    into din_del, pix_del
    from caixa_delivery_partes where caixa_id = c.id;

  select coalesce(sum(valor) filter (where tipo = 'suprimento' and coalesce(forma, 'dinheiro') = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where tipo = 'sangria'    and coalesce(forma, 'dinheiro') = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where tipo = 'suprimento' and forma = 'pix'), 0),
         coalesce(sum(valor) filter (where tipo = 'sangria'    and forma = 'pix'), 0)
    into din_sup, din_san, pix_sup, pix_san
    from caixa_movimentos where caixa_id = c.id;

  esp_din := coalesce(c.valor_abertura, 0) + din_rec + din_del + din_sup - din_san;
  esp_pix := coalesce(c.valor_abertura_pix, 0) + pix_rec + pix_del + pix_sup - pix_san;
  dif_din := coalesce(c.valor_fechamento_informado, 0) - esp_din;
  dif_pix := coalesce(c.valor_fechamento_pix, 0) - esp_pix;

  v_horas := to_char(justify_interval(c.fechado_em - c.aberto_em), 'HH24"h"MI');

  v_texto :=
    U&'\+01F534' || ' *Caixa fechado* — ' || coalesce(v_loja, '') || chr(10) || chr(10) ||
    'Quem fechou: *' || v_quem || '*' || chr(10) ||
    'Quando: ' || to_char(c.fechado_em at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
    ' · ficou aberto ' || v_horas || chr(10) || chr(10) ||
    U&'\+01F4B5' || ' *Dinheiro*' || chr(10) ||
    '   contou ' || reais_br(c.valor_fechamento_informado) || ' · esperado ' || reais_br(esp_din) || chr(10) ||
    '   ' || case
              when abs(dif_din) < 0.01 then U&'\2705' || ' bateu certinho'
              when dif_din > 0 then U&'\26A0\FE0F' || ' *sobrou ' || reais_br(dif_din) || '*'
              else U&'\+01F6A8' || ' *faltou ' || reais_br(abs(dif_din)) || '*'
            end ||
    case when c.valor_fechamento_pix is not null or esp_pix > 0 then
      chr(10) || chr(10) || U&'\+01F4F1' || ' *PIX*' || chr(10) ||
      '   contou ' || reais_br(c.valor_fechamento_pix) || ' · esperado ' || reais_br(esp_pix) || chr(10) ||
      '   ' || case
                 when abs(dif_pix) < 0.01 then U&'\2705' || ' bateu certinho'
                 when dif_pix > 0 then U&'\26A0\FE0F' || ' sobrou ' || reais_br(dif_pix)
                 else U&'\+01F6A8' || ' faltou ' || reais_br(abs(dif_pix))
               end
    else '' end ||
    -- Cartao vai SEM esperado: a conta depende da taxa de cada maquininha.
    case when coalesce(c.valor_fechamento_cartao, 0) > 0 then
      chr(10) || chr(10) || U&'\+01F4B3' || ' Cartão contado: ' || reais_br(c.valor_fechamento_cartao)
    else '' end ||
    case when coalesce(trim(c.observacoes_fechamento), '') <> ''
         then chr(10) || chr(10) || U&'\+01F4DD' || ' ' || c.observacoes_fechamento else '' end;

  return jsonb_build_object('instancia', wc.instancia, 'telefone', wc.admin_phone, 'texto', v_texto);
end;
$$;

revoke all on function public.caixa_aviso(uuid, text) from public, anon, authenticated;

-- ── os gatilhos ─────────────────────────────────────────────────────────────
-- Avisar NUNCA pode impedir alguém de abrir ou fechar o caixa: tudo dentro de
-- begin/exception. Se o pg_net falhar, perde-se o aviso, não a operação.
create or replace function public.caixa_dispara_aviso()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_momento text;
begin
  if tg_op = 'INSERT' then
    v_momento := 'abertura';
  elsif new.fechado_em is not null and old.fechado_em is null then
    v_momento := 'fechamento';
  else
    return new;
  end if;

  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/caixa-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('caixa_id', new.id, 'momento', v_momento),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning '[caixa-aviso] nao consegui avisar: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.caixa_dispara_aviso() from public, anon, authenticated;

drop trigger if exists caixa_avisa_abertura on public.caixas;
create trigger caixa_avisa_abertura
  after insert on public.caixas
  for each row execute function public.caixa_dispara_aviso();

drop trigger if exists caixa_avisa_fechamento on public.caixas;
create trigger caixa_avisa_fechamento
  after update on public.caixas
  for each row execute function public.caixa_dispara_aviso();
