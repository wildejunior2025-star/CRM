-- CAIXA CEGO: QUANDO NÃO BATE, O DONO É AVISADO NA HORA (30/10/2026)
--
-- O vendedor não vê o valor, mas o DONO precisa saber o que não bateu e quanto.
-- Ao tentar fechar e o banco recusar (CAIXA_NAO_BATEU), a tela chama
-- `registrar_nao_bateu`: guarda a tentativa, abre o pedido de liberação no Caixa
-- do dono e manda o WhatsApp dele (função caixa-aviso, momento 'nao_bateu') com
-- cada forma que não bateu, o contado, o esperado e a diferença.
--
-- Quando BATE, nada muda: o fechamento segue mandando a mesma mensagem de sempre.
-- E quando o dono fecha pelo login dele (admin pode fechar sem bater), a mensagem
-- de fechamento já traz "faltou R$ X" / "sobrou R$ X" — é a conta que já existia.

alter table public.caixas
  add column if not exists ultima_tentativa jsonb;

comment on column public.caixas.ultima_tentativa is
  'Última vez que o vendedor tentou fechar e não bateu: {em, por, formas:{dinheiro|pix|cartao:{contado,esperado}}}. Alimenta o aviso ao dono.';

-- ── 1. Registra a tentativa, abre o pedido e avisa o dono ──────────────────
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

  -- A MESMA conferência e as mesmas folgas do fechar_caixa.
  select * into e from caixa_esperado(p_caixa_id);
  if abs(coalesce(p_dinheiro, 0) - coalesce(e.dinheiro, 0)) > 0.011 then
    f := f || jsonb_build_object('dinheiro', jsonb_build_object('contado', coalesce(p_dinheiro, 0), 'esperado', e.dinheiro));
  end if;
  if abs(coalesce(p_pix, 0) - coalesce(e.pix, 0)) > 0.011 then
    f := f || jsonb_build_object('pix', jsonb_build_object('contado', coalesce(p_pix, 0), 'esperado', e.pix));
  end if;
  if abs(coalesce(p_cartao, 0) - coalesce(e.cartao, 0)) > 0.101 then
    f := f || jsonb_build_object('cartao', jsonb_build_object('contado', coalesce(p_cartao, 0), 'esperado', e.cartao));
  end if;
  if f = '{}'::jsonb then return; end if;

  -- Mesma tentativa repetida em menos de 10 minutos não vira outra mensagem:
  -- o vendedor clicando de novo não pode encher o WhatsApp do dono.
  if c.ultima_tentativa is not null
     and (c.ultima_tentativa -> 'formas') = f
     and (c.ultima_tentativa ->> 'em')::timestamptz > now() - interval '10 minutes' then
    return;
  end if;

  update caixas
  set ultima_tentativa = jsonb_build_object('em', now(), 'por', auth.uid(), 'formas', f),
      liberacao_pedida_em = now(),
      liberacao_pedida_por = auth.uid()
  where id = c.id;

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

revoke all on function public.registrar_nao_bateu(uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.registrar_nao_bateu(uuid, numeric, numeric, numeric) to authenticated;

-- ── 2. A mensagem: caixa_aviso ganha o momento 'nao_bateu' ──────────────────
-- (o resto da função é o de sempre; só o bloco do 'nao_bateu' é novo)
create or replace function public.caixa_aviso(p_caixa_id uuid, p_momento text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  c          caixas%rowtype;
  wc         record;
  v_loja     text;
  v_quem     text;
  v_texto    text;
  v_vales    text;
  v_formas   text;
  -- esperado
  din_rec numeric := 0; din_del numeric := 0; din_sup numeric := 0; din_san numeric := 0;
  pix_rec numeric := 0; pix_del numeric := 0; pix_sup numeric := 0; pix_san numeric := 0;
  esp_din numeric; esp_pix numeric; dif_din numeric; dif_pix numeric;
  v_horas text;
  v_fones text[];
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

  v_fones := donos_do_aviso(c.empresa_id);
  if not coalesce(wc.notif_caixa, false) or coalesce(array_length(v_fones, 1), 0) = 0 then
    return null;
  end if;

  select nome into v_loja from empresas where id = c.empresa_id;
  v_quem := estoque_quem_lancou(case when p_momento = 'abertura' then c.aberto_por else c.fechado_por end);

  -- ── tentou fechar e não bateu (caixa cego, mig 0431) ───────────────────────
  if p_momento = 'nao_bateu' then
    if c.ultima_tentativa is null then return null; end if;
    v_quem := estoque_quem_lancou(nullif(c.ultima_tentativa ->> 'por', '')::uuid);

    select string_agg(
             case t.forma when 'dinheiro' then U&'\+01F4B5' || ' *Dinheiro*'
                          when 'pix'      then U&'\+01F4F1' || ' *PIX*'
                          else                 U&'\+01F4B3' || ' *Cartão (conta da maquineta)*' end || chr(10) ||
             '   contou ' || reais_br(t.contado) || ' · esperado ' || reais_br(t.esperado) || chr(10) ||
             '   ' || case when t.contado > t.esperado
                           then U&'\26A0\FE0F' || ' *sobrou ' || reais_br(t.contado - t.esperado) || '*'
                           else U&'\+01F6A8' || ' *faltou ' || reais_br(t.esperado - t.contado) || '*' end,
             chr(10) || chr(10) order by t.ord)
      into v_formas
      from (
        select k.key as forma,
               (k.value ->> 'contado')::numeric as contado,
               (k.value ->> 'esperado')::numeric as esperado,
               case k.key when 'dinheiro' then 1 when 'pix' then 2 else 3 end as ord
          from jsonb_each(c.ultima_tentativa -> 'formas') k
      ) t;

    v_texto :=
      U&'\+01F7E0' || ' *Caixa não bateu* — ' || coalesce(v_loja, '') || chr(10) || chr(10) ||
      'Quem tentou fechar: *' || v_quem || '*' || chr(10) ||
      'Quando: ' || to_char((c.ultima_tentativa ->> 'em')::timestamptz at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
      chr(10) || chr(10) || coalesce(v_formas, '') || chr(10) || chr(10) ||
      'O caixa *não foi fechado*. Feche pelo seu login (você pode fechar mesmo sem bater — ' ||
      'a diferença vai na mensagem de fechamento) ou toque em *Liberar fechamento* na tela do Caixa.';

    return jsonb_build_object('instancia', wc.instancia, 'telefone', v_fones[1], 'telefones', to_jsonb(v_fones), 'texto', v_texto);
  end if;

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

    return jsonb_build_object('instancia', wc.instancia, 'telefone', v_fones[1], 'telefones', to_jsonb(v_fones), 'texto', v_texto);
  end if;

  -- ── fechamento ────────────────────────────────────────────────────────────
  -- Mesma conta da tela do Caixa: abertura + o que entrou em dinheiro
  -- (balcão e delivery) + suprimentos − sangrias. iFood pago no app e PIX do
  -- checkout NAO entram: é faturamento, mas não passou pela gaveta.
  select coalesce(sum(valor) filter (where forma_pagamento = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where forma_pagamento = 'pix'), 0)
    into din_rec, pix_rec
    from pagamentos where caixa_id = c.id;

  -- DELIVERY: pela função própria. A view caixa_delivery_partes filtra por quem
  -- está logado e aqui ninguém está (ver o cabeçalho desta migração).
  select coalesce(sum(valor) filter (where bucket = 'dinheiro'), 0),
         coalesce(sum(valor) filter (where bucket = 'pix'), 0)
    into din_del, pix_del
    from caixa_partes_delivery_do_caixa(c.id);

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

  v_horas := (floor(extract(epoch from (c.fechado_em - c.aberto_em)) / 3600))::int || 'h'
               || lpad((floor(extract(epoch from (c.fechado_em - c.aberto_em)) / 60) % 60)::int::text, 2, '0');

  -- Vales: uma linha por bandeira que a loja conferiu na maquineta (0390).
  -- coalesce em tudo: um NULL no meio de || apaga a mensagem inteira.
  select coalesce(string_agg(
           chr(10) || chr(10) || U&'\+01F37D\FE0F' || ' *' || t.nome || '*' || chr(10) ||
           '   contou ' || reais_br(t.contado) || ' · esperado ' || reais_br(t.esperado) || chr(10) ||
           '   ' || case
                      when abs(t.contado - t.esperado) < 0.01 then U&'\2705' || ' bateu certinho'
                      when t.contado > t.esperado then U&'\26A0\FE0F' || ' sobrou ' || reais_br(t.contado - t.esperado)
                      else U&'\+01F6A8' || ' faltou ' || reais_br(t.esperado - t.contado)
                    end,
           '' order by t.ord), '')
    into v_vales
    from (
      select case k.key when 'pluxee' then 'Pluxee' when 'alelo' then 'Alelo'
                        when 'vr' then 'VR' when 'ticket' then 'Ticket' else k.key end as nome,
             (k.value ->> 'contado')::numeric as contado,
             coalesce((k.value ->> 'esperado')::numeric, 0) as esperado,
             case k.key when 'pluxee' then 1 when 'alelo' then 2 when 'vr' then 3 else 4 end as ord
        from jsonb_each(coalesce(c.conferido_vales, '{}'::jsonb)) k
       where (k.value ->> 'contado') is not null
    ) t;

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
    v_vales ||
    case when coalesce(trim(c.observacoes_fechamento), '') <> ''
         then chr(10) || chr(10) || U&'\+01F4DD' || ' ' || c.observacoes_fechamento else '' end;

  return jsonb_build_object('instancia', wc.instancia, 'telefone', v_fones[1], 'telefones', to_jsonb(v_fones), 'texto', v_texto);
end;
$function$;
