-- 0367_pedido_item_categoria_horario.sql
-- O banco recusa pedido da Loja Online / app com item de categoria que NAO vende agora.
--
-- Por que existe: em 22/10/2026 a CDBom recebeu o pedido #1497 na QUINTA com o
-- Gelo da "Promocao de Quarta" (categoria com dias_semana = {3}). O cardapio so
-- ESCONDIA a categoria fora do dia; a sacola de quarta ficou guardada no celular
-- da cliente e ninguem conferiu de novo na hora de gravar. A tela ja foi
-- corrigida, mas pagina velha aberta (ou chamada direta) ainda passaria — por
-- isso a trava tambem mora aqui.
--
-- Regra = a mesma de src/lib/horarioCategoria.js (categoriaAbertaAgora), no
-- relogio de America/Fortaleza:
--   * dias_semana preenchido: o dia de hoje tem que estar nele (0 = domingo);
--   * hora_inicio e hora_fim: dentro da janela, que pode virar a noite (22h-02h).
--
-- So vale pra quem se serve sozinho: origem 'cardapio' (Loja Online) e 'app'.
-- Balcao e gestor seguem livres (a atendente decide); o robo do WhatsApp tem a
-- propria conferencia; iFood entra como veio de la. Pedido agendado e conferido
-- no dia/hora agendado, nao no de agora.

CREATE OR REPLACE FUNCTION public.fn_pedido_item_categoria_horario()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_quando timestamp;
  v_dow    int;
  v_hora   time;
  v_fora   text;
BEGIN
  IF NEW.origem IS NULL OR NEW.origem NOT IN ('cardapio', 'app') THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.itens) <> 'array' THEN RETURN NEW; END IF;

  v_quando := COALESCE(NEW.agendado_para, now()) AT TIME ZONE 'America/Fortaleza';
  v_dow    := extract(dow from v_quando)::int;
  v_hora   := v_quando::time;

  SELECT string_agg(DISTINCT COALESCE(i.item->>'nome', p.nome), ', ')
    INTO v_fora
    FROM jsonb_array_elements(NEW.itens) AS i(item)
    JOIN produtos p
      ON p.id::text = i.item->>'produto_id'
     AND p.empresa_id = NEW.empresa_id
    JOIN categorias c
      ON c.empresa_id = p.empresa_id
     AND c.nome = p.categoria
   WHERE
     -- dia da semana fora da lista
     ( c.dias_semana IS NOT NULL
       AND array_length(c.dias_semana, 1) IS NOT NULL
       AND NOT (v_dow = ANY (c.dias_semana)) )
     OR
     -- fora da janela de horario (a janela pode virar a noite)
     ( c.hora_inicio IS NOT NULL AND c.hora_fim IS NOT NULL
       AND NOT (
         CASE WHEN c.hora_inicio <= c.hora_fim
              THEN v_hora >= c.hora_inicio AND v_hora < c.hora_fim
              ELSE v_hora >= c.hora_inicio OR  v_hora < c.hora_fim
         END ) );

  IF v_fora IS NOT NULL THEN
    RAISE EXCEPTION 'ITEM_FORA_DO_HORARIO: % nao esta a venda neste dia/horario', v_fora
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pedido_item_categoria_horario ON public.pedidos_delivery;
CREATE TRIGGER trg_pedido_item_categoria_horario
  BEFORE INSERT ON public.pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.fn_pedido_item_categoria_horario();
