-- ─────────────────────────────────────────────────────────────────────────────
-- 0446 — "Entregue agora" passa a contar DA ENTREGA, não de quando pediu
--
-- 12/11/2026, Agv Grill (#39). O cliente deu nota 5 às 16:22, o robô agradeceu,
-- e 8 segundos depois ele escreveu "Muito bom a comida". A resposta que saiu:
-- "Oi! 👋 Para entrega ou retirada, é só acessar nossa loja online 👇" — ou
-- seja, o elogio de quem acabou de almoçar virou convite pra pedir de novo.
--
-- O robô JÁ tem a regra certa (respostaSemIA, pedidoEmAndamento): pedido
-- "entregue" ainda cala a saudação por UMA HORA, porque "obrigado, chegou
-- certinho" não é cliente novo batendo na porta. O que estava errado era o
-- RELÓGIO: `minutos` conta de `created_at`, de quando o cliente FEZ o pedido.
-- O #39 foi feito 14:50 e entregue 16:12 — 91 minutos. Na hora da nota a conta
-- já passava de 60, então pro robô aquele pedido era história antiga e a
-- saudação estava liberada. Quentinha, pizza, qualquer coisa que leve mais de
-- uma hora da sacola até a porta perdia a proteção exatamente no minuto em que
-- ela mais importa: o cliente recebeu e voltou pra falar.
--
-- Em 14 dias isso aconteceu 118 vezes (CDBom 111, Agv 5, Zebu 2).
--
-- A correção é só o relógio. `minutos_status` conta do aviso que saiu pro
-- status ATUAL do pedido — o mesmo instante em que o robô pediu a nota, porque
-- é o `whatsapp_notify_dedup` que marca quando cada aviso foi mandado
-- ("<pedido_id>:entregue"). Sem aviso registrado, cai de volta no created_at,
-- que é o comportamento de antes.
--
-- `minutos` continua igual e no mesmo lugar: quem usa pra outra coisa não
-- sente nada. A coluna nova entra no FIM da lista, de propósito.
-- ─────────────────────────────────────────────────────────────────────────────

-- O tipo de retorno muda (coluna nova), e aí `create or replace` não serve.
drop function if exists public.pedido_do_cliente(uuid, text, integer);

create function public.pedido_do_cliente(
  p_empresa uuid,
  p_phone text,
  p_numero integer default null
)
returns table (
  numero_pedido integer,
  status text,
  tipo_entrega text,
  total numeric,
  minutos integer,
  entregador text,
  minutos_status integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.numero_pedido,
    p.status,
    p.tipo_entrega,
    p.total,
    (extract(epoch from (now() - p.created_at)) / 60)::int as minutos,
    coalesce(pr.nome, '') as entregador,
    -- Quanto tempo desde o AVISO do status atual (foi quando o cliente soube).
    -- Sem aviso registrado, vale o relógio antigo.
    (extract(epoch from (now() - coalesce(d.created_at, p.created_at))) / 60)::int
      as minutos_status
  from pedidos_delivery p
  left join profiles pr on pr.id = p.entregador_id
  left join whatsapp_notify_dedup d on d.id = p.id::text || ':' || p.status
  where p.empresa_id = p_empresa
    -- 8 dígitos é o que sobra igual entre "(84) 99946-3336", "5584999463336"
    -- e "84999463336" — o mesmo critério do resto do robô.
    and length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 8
    and right(regexp_replace(coalesce(p.cliente_telefone, ''), '[^0-9]', '', 'g'), 8)
      = right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 8)
    and (p_numero is null or p.numero_pedido = p_numero)
    -- Sem número, vale o pedido de agora (2 dias): pedido da semana passada já
    -- entregue não é o que ele está perguntando. Com o número na mão, procura
    -- fundo — quem cita "#1024" sabe qual pedido quer.
    and p.created_at > now() - (case when p_numero is null then interval '2 days' else interval '60 days' end)
  order by p.created_at desc
  limit 1
$$;

comment on function public.pedido_do_cliente(uuid, text, integer) is
  'Último pedido do telefone na loja (ou o pedido daquele número), pro robô do WhatsApp responder status sem chutar. minutos = desde que pediu; minutos_status = desde o aviso do status atual.';

-- Sem isto o drop leva os grants embora e o robô perde a função.
--
-- E o `revoke ... from public` NÃO basta: o Supabase tem default privileges que
-- dão execute pro anon e pro authenticated em função nova do schema public — a
-- de antes também estava assim. Como ela é SECURITY DEFINER, qualquer um com a
-- chave anon podia perguntar "qual o último pedido deste telefone nesta loja?".
-- Quem chama é só edge function (service_role), então os dois saem.
revoke all on function public.pedido_do_cliente(uuid, text, integer) from public;
revoke execute on function public.pedido_do_cliente(uuid, text, integer) from anon, authenticated;
grant execute on function public.pedido_do_cliente(uuid, text, integer) to service_role;
