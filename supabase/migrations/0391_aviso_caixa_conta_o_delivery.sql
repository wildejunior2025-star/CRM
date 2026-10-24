-- 0391 — O aviso de fechamento do caixa esquecia o delivery inteiro
--
-- Agv Grill, 24/10/2026: o aviso dizia "sobrou R$ 79,99 no dinheiro e R$ 61,97
-- no PIX". Não sobrou nada: R$ 79,20 e R$ 61,97 eram o delivery em dinheiro e em
-- PIX, que a conta do aviso não via. Somando tudo o esperado era R$ 143,21 e
-- R$ 203,80 — a loja contou R$ 144,00 e R$ 203,80, ou seja, bateu.
--
-- Por quê: caixa_aviso() lia `caixa_delivery_partes`, e essa view só mostra
-- pedidos da loja de QUEM ESTÁ LOGADO (`empresa_id = current_empresa_id()`). O
-- aviso roda sem login (gatilho -> edge function), então current_empresa_id() é
-- NULL e a view volta vazia: delivery zerado, esperado menor, "sobra" inventada.
-- Isso valia pra TODA loja com o aviso ligado (Braseiro, Lá em Casa) que tivesse
-- delivery no caixa. Um alarme falso de sobra é pior que aviso nenhum: o dono
-- passa a desconfiar do funcionário ou deixa de ler o aviso.
--
-- Conserto: a conta do delivery sai numa função própria, SEM o filtro de login,
-- por caixa. É a mesma regra de balde da view (mantenha as duas iguais).
-- Aproveita pra pôr no aviso a conferência de cada vale (0390).

CREATE OR REPLACE FUNCTION caixa_partes_delivery_do_caixa(p_caixa_id uuid)
RETURNS TABLE(bucket text, valor numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT x.bucket, x.valor
    FROM pedidos_delivery d
    CROSS JOIN LATERAL ( SELECT
        CASE
          WHEN d.origem = 'ifood' AND (COALESCE(d.ifood_valores ->> 'pago_online', '') = 'true' OR f.forma = 'online') THEN 'ifood'
          WHEN f.forma = 'online' THEN 'online'
          WHEN f.forma = 'pix' AND d.mp_payment_status = 'approved' THEN 'online'
          WHEN f.forma = 'dinheiro' THEN 'dinheiro'
          WHEN f.forma = ANY (ARRAY['pix', 'pix_entrega']) THEN 'pix'
          WHEN f.forma = 'credito' THEN 'credito'
          WHEN f.forma = 'debito' THEN 'debito'
          WHEN f.forma = 'cartao' THEN 'cartao'
          WHEN f.forma = ANY (ARRAY['pluxee', 'alelo', 'vr', 'ticket']) THEN 'vale'
          ELSE 'outros'
        END AS bucket,
        f.valor
      FROM ( SELECT p.value ->> 'forma' AS forma, (p.value ->> 'valor')::numeric AS valor
               FROM jsonb_array_elements(d.pagamentos) p(value)
              WHERE d.forma_pagamento = 'dividido' AND jsonb_typeof(d.pagamentos) = 'array'
             UNION ALL
             SELECT d.forma_pagamento, d.total
              WHERE d.forma_pagamento IS DISTINCT FROM 'dividido' OR jsonb_typeof(d.pagamentos) IS DISTINCT FROM 'array'
           ) f ) x
   WHERE d.caixa_id = p_caixa_id
     AND d.status <> ALL (ARRAY['cancelado', 'aguardando', 'aguardando_pagamento'])
     AND COALESCE(d.forma_pagamento, '') <> 'fiado'
$$;

REVOKE ALL ON FUNCTION caixa_partes_delivery_do_caixa(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION caixa_partes_delivery_do_caixa(uuid) TO service_role;

CREATE OR REPLACE FUNCTION caixa_aviso(p_caixa_id uuid, p_momento text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare
  c          caixas%rowtype;
  wc         record;
  v_loja     text;
  v_quem     text;
  v_texto    text;
  v_vales    text;
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

  return jsonb_build_object('instancia', wc.instancia, 'telefone', wc.admin_phone, 'texto', v_texto);
end;
$function$;
