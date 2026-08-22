-- Senha de 6 números no link do cliente.
--
-- O link `/c/<token>` não tem login: quem tem o link, é. Isso é ótimo pra
-- pedir sem atrito, mas o link escapa fácil — grupo de família, celular
-- emprestado, print no zap. E quem pegasse o link podia MANDAR PEDIDO no nome
-- do dono, que ia parar na cozinha e virar dívida na conta dele.
--
-- ONDE A SENHA ENTRA: só na hora de ENVIAR o pedido, não pra ver a página.
-- É de propósito. Senha na porta de entrada derruba o pedido por link, que
-- hoje é a coisa mais fácil do sistema; e os clientes que já existem ficariam
-- todos trancados de uma vez. Pedindo no fim, com o pedido já montado, quase
-- ninguém desiste — então na prática todo mundo acaba criando uma.
--
-- SÓ NÚMEROS, exatamente 6. São um milhão de combinações — pouco. O que
-- segura a força bruta é a trava: 5 erros e o link fica 15 minutos parado.
-- Sem ela, um script varre o espaço inteiro em minutos.

ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS senha_hash       text;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS senha_tentativas smallint NOT NULL DEFAULT 0;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS senha_travada_ate timestamptz;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS senha_criada_em  timestamptz;

-- ── Ele já tem senha? ────────────────────────────────────────────────────────
-- A tela pergunta isto pra saber qual popup abrir: o de criar ou o de digitar.
-- Devolve também a trava, pra avisar em vez de deixar o cliente errando à toa.
CREATE OR REPLACE FUNCTION public.cliente_senha_estado(p_token text)
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'tem_senha',   (c.senha_hash IS NOT NULL),
    'travado',     (c.senha_travada_ate IS NOT NULL AND c.senha_travada_ate > now()),
    'travado_ate', c.senha_travada_ate
  )
  FROM clientes c WHERE c.token = p_token;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_senha_estado(text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_senha_estado(text) TO anon, authenticated;

-- pgcrypto mora no schema `extensions` neste projeto, e estas funcoes fixam
-- search_path='public'. Sem qualificar, crypt/gen_salt nao sao encontrados e
-- ninguem consegue criar senha. Qualificar mantem a protecao do SECURITY
-- DEFINER de pe, coisa que alargar o search_path nao faria.

-- ── Criar a senha ────────────────────────────────────────────────────────────
-- Só cria se ainda não existe. Trocar senha esquecida é com a loja (abaixo),
-- senão quem roubou o link trocaria a senha e trancaria o dono pra fora.
CREATE OR REPLACE FUNCTION public.cliente_criar_senha(p_token text, p_senha text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cli clientes%ROWTYPE;
BEGIN
  IF p_senha !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'A senha tem que ter 6 números.';
  END IF;

  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  IF v_cli.senha_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Você já tem uma senha. Se esqueceu, peça pra loja apagar.';
  END IF;

  UPDATE clientes
     SET senha_hash      = extensions.crypt(p_senha, extensions.gen_salt('bf')),
         senha_criada_em = now(),
         senha_tentativas = 0,
         senha_travada_ate = NULL
   WHERE id = v_cli.id;

  RETURN json_build_object('ok', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_criar_senha(text, text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_criar_senha(text, text) TO anon, authenticated;

-- ── Conferir a senha ─────────────────────────────────────────────────────────
-- Usada pelo `cliente_pedir`. Conta o erro e trava aos 5; o acerto zera tudo.
CREATE OR REPLACE FUNCTION public.cliente_senha_ok(p_token text, p_senha text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cli clientes%ROWTYPE;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RETURN false; END IF;

  -- Sem senha criada ainda: não é o lugar de barrar (quem barra é o pedir).
  IF v_cli.senha_hash IS NULL THEN RETURN true; END IF;

  IF v_cli.senha_travada_ate IS NOT NULL AND v_cli.senha_travada_ate > now() THEN
    RAISE EXCEPTION 'Muitas tentativas erradas. Espere % minutos e tente de novo.',
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_cli.senha_travada_ate - now())) / 60));
  END IF;

  IF v_cli.senha_hash = extensions.crypt(COALESCE(p_senha, ''), v_cli.senha_hash) THEN
    UPDATE clientes SET senha_tentativas = 0, senha_travada_ate = NULL WHERE id = v_cli.id;
    RETURN true;
  END IF;

  UPDATE clientes
     SET senha_tentativas  = senha_tentativas + 1,
         senha_travada_ate = CASE WHEN senha_tentativas + 1 >= 5
                                  THEN now() + interval '15 minutes' ELSE NULL END
   WHERE id = v_cli.id;

  RETURN false;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_senha_ok(text, text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_senha_ok(text, text) TO anon, authenticated;

-- ── Esqueceu a senha: a loja apaga ───────────────────────────────────────────
-- Quem reconhece o cliente é a loja, não o sistema — não há e-mail nem SMS
-- neste fluxo. Apagada a senha, ele cria uma nova no próximo pedido.
CREATE OR REPLACE FUNCTION public.cliente_apagar_senha(p_cliente_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF current_perfil() NOT IN ('admin', 'vendedor') THEN
    RAISE EXCEPTION 'Sem permissão para apagar a senha do cliente';
  END IF;

  UPDATE clientes
     SET senha_hash = NULL, senha_criada_em = NULL,
         senha_tentativas = 0, senha_travada_ate = NULL
   WHERE id = p_cliente_id AND empresa_id = current_empresa_id();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cliente_apagar_senha(uuid) TO authenticated;


-- ── O pedido passa a exigir a senha ──────────────────────────────────────────
-- Corpo igual ao que já rodava; entrou só o parâmetro da senha e as duas
-- checagens no começo.
--
-- O DROP da versão de 2 argumentos NÃO é limpeza: acrescentar um parâmetro com
-- DEFAULT cria uma SOBRECARGA, não substitui. As duas conviveriam, e qualquer
-- chamada com 2 argumentos — a do site antigo em cache, ou alguém batendo
-- direto na API — entraria pela porta velha, sem senha nenhuma.
DROP FUNCTION IF EXISTS public.cliente_pedir(text, jsonb);

CREATE OR REPLACE FUNCTION public.cliente_pedir(p_token text, p_itens jsonb, p_senha text DEFAULT NULL)
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

  -- Senha: quem ainda não criou é mandado criar pela tela; quem já tem precisa
  -- digitar. O pedido não passa sem uma das duas coisas. As mensagens são
  -- códigos secos de propósito — a tela é que sabe qual popup abrir.
  IF v_cli.senha_hash IS NULL THEN
    RAISE EXCEPTION 'SENHA_AUSENTE';
  END IF;
  IF NOT cliente_senha_ok(p_token, p_senha) THEN
    RAISE EXCEPTION 'SENHA_ERRADA';
  END IF;

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

REVOKE EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb, text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb, text) TO anon, authenticated;
