-- 0147_link_do_cliente.sql
-- LINK DO CLIENTE: cada cliente cadastrado ganha um link só dele, tipo o QR da
-- mesa, onde ele mesmo faz o pedido — e o pedido cai como comanda no sistema.
--
-- Por quê: na Estação o freguês já é conhecido (metade fia). Em vez de ligar ou
-- mandar no zap "quero uma quentinha", ele abre o link dele, monta o pedido e
-- isso vira uma Comanda no nome dele, direto na cozinha. No mesmo link ele vê o
-- que está devendo e o que já pagou, sem precisar perguntar pra ninguém.
--
-- Reaproveita o que já existe:
--   • o modelo do QR da mesa (mig 0055): token na linha, funções SECURITY DEFINER
--     liberadas pro anônimo, toda a validação dentro da função;
--   • a comanda de balcão (mig 0143): comanda sem mesa, numerada por dia. O pedido
--     do link vira exatamente isso, já com o cliente ligado.
--
-- Decidido com o Wilde (06/08/2026):
--   • o pedido CAI DIRETO na cozinha, igual ao QR da mesa (sem fila de aprovação);
--   • FORA DO HORÁRIO não deixa pedir. A grade semanal e as exceções (feriado,
--     data especial) são conferidas aqui no banco — o app também confere, mas quem
--     recusa de verdade é esta função, senão bastava mexer no navegador.
--
-- Desligado por padrão: nenhuma loja ganha link de cliente sem ligar o botão.

-- 1) Interruptor por loja
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS link_cliente_ativo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.link_cliente_ativo IS
  'true = cada cliente da loja tem um link proprio pra fazer pedido (vira comanda).';

-- 2) Token do cliente — mesmo formato do token da mesa (10 hex), único no banco.
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS token text
  DEFAULT lower(substring(replace(gen_random_uuid()::text, '-', ''), 1, 10));

UPDATE public.clientes
   SET token = lower(substring(replace(gen_random_uuid()::text, '-', ''), 1, 10))
 WHERE token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_token ON public.clientes(token);

-- 3) A loja está aberta AGORA? Confere a grade semanal + as exceções por data.
--    Feriado calculado (Carnaval, Corpus Christi...) fica por conta do app — aqui
--    entra o que está gravado: a grade e as datas marcadas na mão.
CREATE OR REPLACE FUNCTION public.loja_aberta_agora(p_empresa uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agora   timestamp := (now() AT TIME ZONE 'America/Sao_Paulo');
  v_dia     date      := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora    text      := to_char((now() AT TIME ZONE 'America/Sao_Paulo'), 'HH24:MI');
  v_grade   jsonb;
  v_exc     record;
  v_periodos jsonb;
  v_p       jsonb;
BEGIN
  SELECT horarios_funcionamento INTO v_grade FROM empresas WHERE id = p_empresa;

  -- Exceção da data manda mais que a grade (mig 0142: feriado que fecha OU abre).
  SELECT aberto, periodos INTO v_exc
  FROM dias_excecao WHERE empresa_id = p_empresa AND data = v_dia;

  IF FOUND THEN
    IF NOT COALESCE(v_exc.aberto, false) THEN RETURN false; END IF;
    v_periodos := COALESCE(v_exc.periodos, '[]'::jsonb);
    -- Exceção "abre" sem horário definido: vale a grade do dia.
    IF jsonb_array_length(v_periodos) = 0 THEN
      v_periodos := COALESCE(v_grade -> EXTRACT(dow FROM v_dia)::int -> 'periodos', '[]'::jsonb);
    END IF;
  ELSE
    IF v_grade IS NULL THEN RETURN true; END IF;   -- loja sem grade: não trava ninguém
    IF NOT COALESCE((v_grade -> EXTRACT(dow FROM v_dia)::int ->> 'aberto')::boolean, false) THEN
      RETURN false;
    END IF;
    v_periodos := COALESCE(v_grade -> EXTRACT(dow FROM v_dia)::int -> 'periodos', '[]'::jsonb);
  END IF;

  IF jsonb_array_length(v_periodos) = 0 THEN RETURN true; END IF;

  FOR v_p IN SELECT * FROM jsonb_array_elements(v_periodos)
  LOOP
    -- Vira o dia (ex.: 18:00 às 02:00): vale se está depois de abrir OU antes de fechar.
    IF (v_p->>'f') < (v_p->>'i') THEN
      IF v_hora >= (v_p->>'i') OR v_hora <= (v_p->>'f') THEN RETURN true; END IF;
    ELSIF v_hora >= (v_p->>'i') AND v_hora <= (v_p->>'f') THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.loja_aberta_agora(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loja_aberta_agora(uuid) TO authenticated, service_role;

-- 4) Quem é o dono do link (o anônimo lê isto ao abrir a página)
CREATE OR REPLACE FUNCTION public.cliente_info(p_token text)
 RETURNS json
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'cliente_id',       c.id,
    'cliente_nome',     c.nome,
    'empresa_id',       e.id,
    'empresa_nome',     e.nome,
    'logo_url',         e.logo_url,
    'link_ativo',       COALESCE(e.link_cliente_ativo, false),
    'presencial_ativo', COALESCE(e.presencial_ativo, false),
    'sem_obrigatorios', COALESCE(e.presencial_sem_obrigatorios, false),
    'aberta_agora',     loja_aberta_agora(e.id),
    'grade',            e.horarios_funcionamento,
    'fecha_feriado',    COALESCE(e.feriados_fecha, false)
  )
  FROM clientes c JOIN empresas e ON e.id = c.empresa_id
  WHERE c.token = p_token;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_info(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_info(text) TO anon, authenticated;

-- 5) O cliente manda o pedido: vira comanda de balcão no nome dele.
--    Pediu de novo com a comanda ainda aberta? Entra na mesma — igual mesa.
CREATE OR REPLACE FUNCTION public.cliente_pedir(p_token text, p_itens jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli     clientes%ROWTYPE;
  v_emp     uuid;
  v_empresa empresas%ROWTYPE;
  v_comanda uuid;
  v_dia     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_num     integer;
  v_item    jsonb;
  v_n       integer := 0;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  v_emp := v_cli.empresa_id;
  SELECT * INTO v_empresa FROM empresas WHERE id = v_emp;
  IF NOT COALESCE(v_empresa.link_cliente_ativo, false) THEN
    RAISE EXCEPTION 'A loja não está aceitando pedido por link agora.';
  END IF;
  IF NOT COALESCE(v_empresa.presencial_ativo, false) THEN
    RAISE EXCEPTION 'Pedido indisponível no momento.';
  END IF;
  IF NOT loja_aberta_agora(v_emp) THEN
    RAISE EXCEPTION 'A loja está fechada agora. Faça o pedido no horário de funcionamento.';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Nenhum item no pedido.';
  END IF;

  -- Comanda aberta deste cliente (pediu de novo → soma na mesma conta)
  SELECT id INTO v_comanda FROM comandas
  WHERE empresa_id = v_emp AND cliente_id = v_cli.id AND status = 'aberta'
  ORDER BY created_at LIMIT 1;

  IF v_comanda IS NULL THEN
    -- Mesmo número/dia da comanda de balcão (mig 0143): trava por loja+dia pra
    -- dois pedidos ao mesmo tempo não pegarem o mesmo número.
    PERFORM pg_advisory_xact_lock(hashtext(v_emp::text || v_dia::text));
    SELECT COALESCE(MAX(numero_mesa), 0) + 1 INTO v_num
    FROM comandas WHERE empresa_id = v_emp AND tipo = 'balcao' AND dia = v_dia;

    INSERT INTO comandas (empresa_id, mesa_id, numero_mesa, tipo, nome_cliente, dia,
                          cliente_id, status, observacoes)
    VALUES (v_emp, NULL, v_num, 'balcao', v_cli.nome, v_dia,
            v_cli.id, 'aberta', 'Pedido pelo link do cliente')
    RETURNING id INTO v_comanda;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    INSERT INTO comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario, quantidade, observacao, status)
    VALUES (v_emp, v_comanda,
            NULLIF(v_item->>'produto_id',''),
            v_item->>'nome',
            COALESCE((v_item->>'preco')::numeric, 0),
            GREATEST(1, COALESCE((v_item->>'qtd')::int, 1)),
            NULLIF(v_item->>'obs',''),
            'pendente');
    v_n := v_n + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'itens', v_n, 'comanda_id', v_comanda);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb) TO anon, authenticated;

-- 6) A conta do cliente: o pedido de agora + o que ele deve + o que já pagou.
--    Tudo por token: o cliente não tem login, então nada aqui pode vir de RLS.
CREATE OR REPLACE FUNCTION public.cliente_conta(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli     clientes%ROWTYPE;
  v_comanda comandas%ROWTYPE;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  SELECT * INTO v_comanda FROM comandas
  WHERE empresa_id = v_cli.empresa_id AND cliente_id = v_cli.id
    AND status IN ('aberta','aguardando_conferencia')
  ORDER BY created_at LIMIT 1;

  RETURN json_build_object(
    'cliente_nome', v_cli.nome,
    -- Comanda aberta agora (null se não tem pedido rolando)
    'comanda', CASE WHEN v_comanda.id IS NULL THEN NULL ELSE json_build_object(
      'id',       v_comanda.id,
      'numero',   v_comanda.numero_mesa,
      'status',   v_comanda.status,
      'subtotal', (SELECT COALESCE(SUM(preco_unitario * quantidade), 0)
                     FROM comanda_itens WHERE comanda_id = v_comanda.id),
      'itens',    (SELECT COALESCE(json_agg(json_build_object(
                            'id', i.id, 'nome', i.nome, 'quantidade', i.quantidade,
                            'preco', i.preco_unitario, 'status', i.status,
                            'observacao', i.observacao) ORDER BY i.created_at), '[]'::json)
                     FROM comanda_itens i WHERE i.comanda_id = v_comanda.id)
    ) END,
    -- Quanto ele deve hoje (mesma conta da tela do fiado da loja)
    'saldo_fiado', COALESCE((SELECT saldo_fiado FROM clientes_saldo_fiado WHERE cliente_id = v_cli.id), 0),
    -- O que ficou fiado (as compras que viraram dívida)
    'fiados', (SELECT COALESCE(json_agg(json_build_object(
                        'data', v.created_at, 'valor', v.total) ORDER BY v.created_at DESC), '[]'::json)
                 FROM vendas v
                WHERE v.cliente_id = v_cli.id AND v.forma_pagamento <> 'a_vista'
                  AND v.status <> 'cancelado'),
    -- O que ele já pagou da dívida (só recebimento de fiado; pagamento de mesa
    -- fica de fora, senão pareceria que ele quitou o que na verdade só consumiu)
    'pagamentos', (SELECT COALESCE(json_agg(json_build_object(
                            'data', p.created_at, 'valor', p.valor,
                            'forma', p.forma_pagamento) ORDER BY p.created_at DESC), '[]'::json)
                     FROM pagamentos p
                    WHERE p.cliente_id = v_cli.id
                      AND p.venda_id IS NULL
                      AND COALESCE(p.observacao,'') NOT LIKE 'Presencial ·%')
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_conta(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_conta(text) TO anon, authenticated;
