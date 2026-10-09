-- O ROBÔ DO LINK PASSA A RESPONDER SOBRE PRODUTO (09/10/2026)
--
-- POR QUE EXISTE
-- Hoje o robô sem IA responde horário, endereço, taxa e manda o cardápio — mas
-- "tem picolé de uva?" ele não responde: manda o link e pronto. Quem pergunta
-- preço está decidindo comprar, e mandar procurar no cardápio é onde a venda
-- esfria. O robô com IA resolve isso, só que cada resposta dele custa (Claude).
-- Aqui a resposta sai do BANCO: custo zero por mensagem.
--
-- OPCIONAL POR LOJA: `resposta_produto_ativo` (padrão DESLIGADO). Loja que não
-- quiser falar de preço no WhatsApp continua exatamente como está.
alter table public.whatsapp_config
  add column if not exists resposta_produto_ativo boolean not null default false;

comment on column public.whatsapp_config.resposta_produto_ativo is
  'Robô sem IA responde "tem X? quanto é?" com preço e link do produto (mig 0312)';

-- ── A busca que o robô usa ───────────────────────────────────────────────────
-- Igual à `buscar_produto_nome` (migs 0227/0232), com três diferenças que o
-- preço exige:
--   • devolve promoção e faixas de atacado — dizer "R$ 4,00" quando o produto
--     está a R$ 2,50 na promoção é perder a venda e a confiança;
--   • esconde categoria FORA DO HORÁRIO/DIA (mig 0096): o robô não pode vender
--     a janta às 9h da manhã nem a promoção de quarta na segunda;
--   • devolve a descrição, que é onde a loja escreve tamanho e sabor.
create or replace function public.buscar_produto_cardapio(
  p_empresa uuid,
  p_termo   text,
  p_limite  int default 3
)
returns table (
  id uuid, nome text, preco numeric, promo numeric,
  faixas jsonb, categoria text, embalagem text, descricao text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with agora as (select (now() at time zone 'America/Fortaleza') as ts)
  select p.id, p.nome, coalesce(p.preco_venda, 0),
         nullif(p.preco_promocional, 0), p.faixas_preco,
         p.categoria, p.embalagem, p.descricao
  from produtos p
  cross join agora a
  left join categorias c
    on c.empresa_id = p.empresa_id and c.nome = p.categoria
  where p.empresa_id = p_empresa
    and p.ativo
    and p.disponivel_delivery
    and p.arquivado_em is null
    and length(btrim(p_termo)) >= 3
    and (
      unaccent(lower(p.nome)) like '%' || unaccent(lower(btrim(p_termo))) || '%'
      or unaccent(lower(coalesce(p.categoria, ''))) like '%' || unaccent(lower(btrim(p_termo))) || '%'
    )
    and (
      c.id is null
      or (
        (c.dias_semana is null or array_length(c.dias_semana, 1) is null
         or extract(dow from a.ts)::int = any(c.dias_semana))
        and (
          c.hora_inicio is null or c.hora_fim is null
          or case when c.hora_inicio <= c.hora_fim
                  then a.ts::time >= c.hora_inicio and a.ts::time < c.hora_fim
                  -- janela que vira a madrugada (22:00 → 02:00)
                  else a.ts::time >= c.hora_inicio or a.ts::time < c.hora_fim
             end
        )
      )
    )
  -- Casou no nome vem antes de casou na categoria; entre iguais, o nome mais
  -- curto e mais parecido primeiro (quem pergunta "coca" quer a Coca-Cola, não
  -- a "Coca-Cola Zero Limão Pack com 6").
  order by greatest(
             similarity(unaccent(lower(p.nome)), unaccent(lower(btrim(p_termo)))),
             similarity(unaccent(lower(coalesce(p.categoria, ''))), unaccent(lower(btrim(p_termo)))) * 0.9
           ) desc,
           length(p.nome) asc
  limit greatest(1, least(p_limite, 20));
$$;

grant execute on function public.buscar_produto_cardapio(uuid, text, int) to anon, authenticated, service_role;
