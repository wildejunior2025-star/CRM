-- Categoria com o mesmo nome já vale como vínculo (23/10/2026)
--
-- A 0377 resolvia o setor em três degraus: produto nosso -> vínculo explícito
-- de categoria -> cozinha. O vínculo explícito guarda o ID da categoria do
-- iFood, o que é certo: nome diverge (as duas lojas do Agv já escrevem
-- "Pastéis"/"Pasteis", "Hot Dog"/"Hot dog", "Marmitas"/"Marmitas (1)") e não
-- existe espelhamento de renomeação entre os dois lados.
--
-- Só que exigir vínculo explícito pra TUDO cria trabalho onde não precisa. O
-- caminho normal é o lojista reativar "Hot Dog" no iFood e criar "Hot Dog"
-- aqui — nesse caso os nomes nascem iguais e perguntar de novo é burocracia.
--
-- Então entra um degrau intermediário: categoria daqui com o MESMO NOME da de
-- lá (sem acento, sem caixa) vale como vínculo. Criar a categoria aqui já
-- liga, sem clique. O vínculo explícito continua existindo e tem precedência —
-- é ele que resolve os nomes divergentes e o que sobrevive a renomeação.
--
-- A ordem final, do mais específico pro mais genérico:
--   1. produto        — produto nosso com o mesmo nome (traz estoque junto)
--   2. vinculo        — categoria do iFood ligada na mão, por id
--   3. categoria_nome — categoria daqui com o mesmo nome da de lá
--   4. desconhecido   — COZINHA, marcado. Papel sobrando é chateação; prato
--                       que ninguém preparou é pedido perdido.

create or replace function public.resolver_setor_ifood(
  p_empresa  uuid,
  p_merchant text,
  p_itens    jsonb        -- [{"nome": "...", "id": "..."}]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with item as (
    select ord                      as pos,
           coalesce(e->>'nome', '') as nome,
           coalesce(e->>'id', '')   as item_id
      from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) with ordinality as t(e, ord)
  ),
  achado as (
    select
      i.pos, i.nome, i.item_id,

      -- 1. produto nosso com o mesmo nome
      (select pc_setor(c.setor)
         from produtos p
         left join categorias c
           on c.empresa_id = p.empresa_id and c.nome = p.categoria
        where p.empresa_id = p_empresa
          and lower(unaccent(p.nome)) = lower(unaccent(i.nome))
        limit 1) as por_produto,

      -- 2. vínculo explícito, pelo id da categoria do iFood
      (select pc_setor(c.setor)
         from ifood_cardapio_item ci
         join ifood_categoria_vinculo v
           on v.merchant_id = ci.merchant_id
          and v.categoria_ifood_id = ci.categoria_id
         join categorias c on c.id = v.categoria_id
        where ci.merchant_id = p_merchant
          and ci.item_id = i.item_id
        limit 1) as por_vinculo,

      -- 3. categoria daqui com o mesmo nome da de lá
      (select pc_setor(c.setor)
         from ifood_cardapio_item ci
         join categorias c
           on c.empresa_id = p_empresa
          and lower(unaccent(c.nome)) = lower(unaccent(ci.categoria_nome))
        where ci.merchant_id = p_merchant
          and ci.item_id = i.item_id
        limit 1) as por_nome

      from item i
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'nome',  a.nome,
             'id',    a.item_id,
             'setor', coalesce(a.por_produto, a.por_vinculo, a.por_nome, 'cozinha'),
             'fonte', case
                        when a.por_produto is not null then 'produto'
                        when a.por_vinculo is not null then 'vinculo'
                        when a.por_nome    is not null then 'categoria_nome'
                        else 'desconhecido'
                      end
           ) order by a.pos
         ), '[]'::jsonb)
    from achado a;
$$;

comment on function public.resolver_setor_ifood(uuid, text, jsonb) is
  'Setor de cada item do iFood: produto -> vinculo de categoria -> categoria de mesmo nome -> cozinha (nao cadastrado).';
