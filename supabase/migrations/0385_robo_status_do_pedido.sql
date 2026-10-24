-- ─────────────────────────────────────────────────────────────────────────────
-- 0385 — O robô do link sabe responder "e o meu pedido?"
--
-- 24/10/2026: cliente do Agv Grill escreveu "Olá! Sobre o meu pedido #1024..."
-- e o robô respondeu com a mensagem de FAZER um pedido ("é só escolher,
-- adiciona na sacola..."). Quem já pediu e está esperando recebe um convite a
-- pedir de novo — é a pior resposta possível nesse momento.
--
-- Por que uma função no banco e não uma consulta na edge function: o telefone
-- em `pedidos_delivery.cliente_telefone` está MASCARADO ("(84) 99946-3336"), e
-- o resto do robô casa número pelos 8 últimos dígitos com LIKE. Com a máscara
-- no meio ("99946-3336"), LIKE '%99463336' não casa com nada. Aqui dá pra
-- tirar a máscara com regexp_replace antes de comparar.
--
-- PRIVACIDADE: só devolve pedido do PRÓPRIO número de quem está falando. Pedir
-- "#1024" de um número diferente não devolve nada (e o robô chama gente), em
-- vez de contar pra um estranho o que a vizinha pediu.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.pedido_do_cliente(
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
  entregador text
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
    coalesce(pr.nome, '') as entregador
  from pedidos_delivery p
  left join profiles pr on pr.id = p.entregador_id
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
  'Último pedido do telefone na loja (ou o pedido daquele número), pro robô do WhatsApp responder status sem chutar.';

revoke all on function public.pedido_do_cliente(uuid, text, integer) from public;
grant execute on function public.pedido_do_cliente(uuid, text, integer) to service_role;
