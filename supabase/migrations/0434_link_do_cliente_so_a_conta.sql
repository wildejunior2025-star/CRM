-- 0434_link_do_cliente_so_a_conta.sql
-- O LINK DO CLIENTE DEIXA DE SER UM CANAL DE PEDIDO E VIRA A CONTA DO FREGUÊS.
--
-- Como era (mig 0147): o freguês abria o link dele, montava o pedido e isso
-- virava uma COMANDA de balcão, na tela do Salão. Em 3 meses saíram 8 pedidos
-- assim nas duas lojas que tinham a função ligada — e na CDBom duas comandas
-- ficaram abertas na tela do Salão sem ninguém saber de onde vinham, porque a
-- loja não usa mesa e ninguém olha aquela tela (27/10/2026).
--
-- Decisão do Wilde (31/10/2026): "acho que vai funciona melhor se chega na tela
-- de delivery... no link dele ele só visse os pedidos que ele fez e o link de
-- indicação e quanto ele deve; mais quando fosse fazer pedido nós jogaria ele
-- pra o link do catálogo atrelado o login dele".
--
-- Então agora:
--   • o link pessoal (/c/{token}) mostra PEDIDOS, CONTA e INDICAR — e nada mais;
--   • "Fazer pedido" manda pro catálogo da loja já identificado:
--       lojaonline.fwcinter.com/{slug}?t={telefone}
--     que é o mesmo caminho do link do robô: o checkout abre com nome, endereço
--     e pino preenchidos, enxerga o cashback pelo telefone, e o pedido cai na
--     tela de Delivery, onde a loja já olha. Entrega x retirada já é escolha da
--     loja lá (aceita_entrega / aceita_retirada), não precisa de nada novo.
--
-- Três mudanças aqui:
--   1) cliente_info devolve o slug e o telefone (pra montar aquele link);
--   2) cliente_pedidos: os pedidos de delivery DELE, achados pelo cadastro e
--      também pelo telefone (metade dos pedidos antigos não tem cliente_id);
--   3) cliente_pedir recusa, com recado. A loja tem service worker: celular com
--      a versão velha da página em cache continuaria mandando comanda pro Salão
--      — exatamente o que estamos consertando.

-- 1) Quem é o dono do link + por onde ele pede agora
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
    'fecha_feriado',    COALESCE(e.feriados_fecha, false),
    -- Pra montar o link do catálogo com ele já identificado. O telefone é o
    -- mesmo que ele vê no cadastro dele; quem abre a página já é ele (o token
    -- é o segredo), então não entrega nada que a página não mostrasse.
    'slug',             e.slug,
    'telefone',         NULLIF(regexp_replace(COALESCE(c.telefone, ''), '\D', '', 'g'), '')
  )
  FROM clientes c JOIN empresas e ON e.id = c.empresa_id
  WHERE c.token = p_token;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_info(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_info(text) TO anon, authenticated;

-- 2) Os pedidos de delivery dele.
--    Acha por cadastro (cliente_id) E por telefone: dos 2.695 pedidos dos
--    últimos 30 dias, só 1.300 têm cliente_id gravado — o resto é o mesmo
--    freguês, achado pelo número. Sem o telefone o histórico sairia pela metade.
CREATE OR REPLACE FUNCTION public.cliente_pedidos(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli clientes%ROWTYPE;
  v_tel text;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  v_tel := regexp_replace(COALESCE(v_cli.telefone, ''), '\D', '', 'g');
  IF length(v_tel) < 10 THEN v_tel := NULL; END IF;

  RETURN COALESCE((
    SELECT json_agg(json_build_object(
             'id',     p.id,
             'numero', p.numero_pedido,
             'status', p.status,
             'tipo',   p.tipo_entrega,
             'forma',  p.forma_pagamento,
             'total',  p.total,
             'quando', p.created_at,
             'itens',  (SELECT COALESCE(json_agg(json_build_object(
                                 'nome',       i->>'nome',
                                 'quantidade', COALESCE((i->>'quantidade')::numeric, (i->>'qtd')::numeric, 1),
                                 'valor',      COALESCE((i->>'subtotal')::numeric, 0)
                               )), '[]'::json)
                          FROM jsonb_array_elements(COALESCE(p.itens, '[]'::jsonb)) i)
           ) ORDER BY p.created_at DESC)
    FROM (
      SELECT d.*
        FROM pedidos_delivery d
       WHERE d.empresa_id = v_cli.empresa_id
         AND (d.cliente_id = v_cli.id
              OR (v_tel IS NOT NULL
                  AND regexp_replace(COALESCE(d.cliente_telefone, ''), '\D', '', 'g') = v_tel))
       ORDER BY d.created_at DESC
       LIMIT 15
    ) p
  ), '[]'::json);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_pedidos(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_pedidos(text) TO anon, authenticated;

-- 3) Pedido pelo link pessoal: não existe mais.
--    Mantida a função (em vez de tirar a permissão) só pra quem abrir a página
--    velha receber um recado em português, e não um erro de permissão.
CREATE OR REPLACE FUNCTION public.cliente_pedir(p_token text, p_itens jsonb, p_senha text DEFAULT NULL::text, p_usar_cashback boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'O pedido agora é pelo catálogo da loja. Atualize a página e toque em "Fazer pedido".';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_pedir(text, jsonb, text, boolean) TO anon, authenticated;

COMMENT ON COLUMN public.empresas.link_cliente_ativo IS
  'true = cada cliente da loja tem um link proprio com a conta dele (fiado, pedidos, indicacao). O pedido em si vai pelo catalogo (mig 0434).';
