-- De que setor é o item que veio do iFood (23/10/2026)
--
-- POR QUE EXISTE
-- O app da impressora descobre o setor de um item pelo NOME, comparando com os
-- nossos produtos. Isso basta na mesa, onde tudo é lançado do nosso catálogo.
-- No iFood não: o cardápio mora lá, e lá ele é escrito como o lojista quiser.
--
-- No Agv são duas lojas no iFood com cardápios parecidos e escritos diferente:
-- "Filé à parmegiana de frango" numa, "File parmegiana de frango" na outra.
-- Pro casamento por nome são dois produtos distintos — e um deles não acha
-- nada. Quando o item não acha produto, a regra antiga mandava ele pra "salão",
-- ou seja: NÃO SAI na comanda da cozinha. Sem erro, sem aviso. Com a cozinha
-- longe do balcão (que é o caso do Agv), é prato que ninguém preparou.
--
-- Hoje isso atinge 1 item. Mas as categorias Espetinhos, Pastéis, Lanches e
-- Hot Dog estão PAUSADAS no iFood das duas lojas; no dia em que voltarem, são
-- 27 itens de cozinha entrando de uma vez, todos mudos.
--
-- COMO RESOLVE, em três degraus do mais específico pro mais genérico:
--   1. Produto nosso com o mesmo nome  -> usa o setor da categoria dele.
--   2. Categoria do iFood vinculada    -> usa o setor da categoria nossa.
--   3. Não achou nada                  -> COZINHA, marcado como não cadastrado.
--
-- O degrau 3 é o que inverte o risco. Papel sobrando na cozinha é chateação;
-- prato que ninguém preparou é pedido perdido. E, marcado, ele deixa de ser
-- acidente silencioso e vira recado: apareceu coisa nova lá que ninguém ligou
-- aqui ainda.
--
-- Por que o vínculo é por CATEGORIA e não por produto: são ~13 categorias por
-- loja contra 80 itens, e item novo criado lá dentro de uma categoria já
-- conhecida entra roteado sozinho, sem ninguém manter lista nenhuma.
--
-- Por que guarda o ID da categoria do iFood e não o nome: nome diverge. As duas
-- lojas já escrevem "Pastéis"/"Pasteis", "Hot Dog"/"Hot dog", "Marmitas"/
-- "Marmitas (1)". E não existe espelhamento de renomeação entre os dois lados:
-- quem renomeia de um lado diverge do outro na hora. O id não muda.

-- ── cópia do cardápio do iFood ──────────────────────────────────────────────
-- O PEDIDO NÃO DIZ A CATEGORIA DO ITEM. Ele manda nome, código e um id; o campo
-- `category` do pedido vale "FOOD", que é o tipo do pedido, não a do cardápio.
-- Então a categoria tem que vir daqui, de uma cópia que um sync mantém.
--
-- A chave é o `itemContextId` do catálogo, que é o MESMO id que chega no item
-- do pedido. Não confundir com `items[].id` do catálogo (esse é outro número,
-- e é o que está gravado em produtos.ifood_item_id). Conferido nos dois
-- cardápios do Agv: 80/80 e 67/67 itens têm, e não repete.
create table if not exists public.ifood_cardapio_item (
  merchant_id    text not null,
  item_id        text not null,              -- itemContextId = id do item no pedido
  empresa_id     uuid not null references public.empresas(id) on delete cascade,
  nome           text not null default '',
  categoria_id   text not null default '',   -- id da categoria no iFood
  categoria_nome text not null default '',   -- só pra humano se achar na tela
  atualizado_em  timestamptz not null default now(),
  primary key (merchant_id, item_id)
);

create index if not exists idx_ifood_cardapio_empresa on public.ifood_cardapio_item (empresa_id);

alter table public.ifood_cardapio_item enable row level security;

drop policy if exists "Loja ve o proprio cardapio do ifood" on public.ifood_cardapio_item;
create policy "Loja ve o proprio cardapio do ifood"
  on public.ifood_cardapio_item for all
  using      (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

drop policy if exists "Super admin ve o cardapio do ifood" on public.ifood_cardapio_item;
create policy "Super admin ve o cardapio do ifood"
  on public.ifood_cardapio_item for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- ── o vínculo: categoria de lá -> categoria daqui ───────────────────────────
create table if not exists public.ifood_categoria_vinculo (
  merchant_id          text not null,
  categoria_ifood_id   text not null,
  empresa_id           uuid not null references public.empresas(id) on delete cascade,
  categoria_id         uuid not null references public.categorias(id) on delete cascade,
  categoria_nome_ifood text not null default '',
  criado_em            timestamptz not null default now(),
  primary key (merchant_id, categoria_ifood_id)
);

create index if not exists idx_ifood_vinculo_empresa on public.ifood_categoria_vinculo (empresa_id);

alter table public.ifood_categoria_vinculo enable row level security;

drop policy if exists "Loja cuida dos proprios vinculos" on public.ifood_categoria_vinculo;
create policy "Loja cuida dos proprios vinculos"
  on public.ifood_categoria_vinculo for all
  using      (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

drop policy if exists "Super admin cuida dos vinculos" on public.ifood_categoria_vinculo;
create policy "Super admin cuida dos vinculos"
  on public.ifood_categoria_vinculo for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- Normaliza o setor igual o app faz: só 'cozinha' e 'nenhum' valem; o resto
-- (inclusive null, que é categoria sem setor marcado) é 'salao'.
create or replace function public.pc_setor(p text)
returns text
language sql
immutable
as $$ select case when p in ('cozinha', 'nenhum') then p else 'salao' end $$;

-- ── a decisão ───────────────────────────────────────────────────────────────
-- Recebe os itens do pedido ({nome, id}) e devolve o setor de cada um. Fica no
-- banco, e não na edge function, por dois motivos: é a mesma resposta que a
-- tela vai querer mostrar ("onde este item vai sair?"), e dá pra conferir item
-- por item com um SELECT, sem precisar de pedido de verdade pra testar.
--
-- 'salao' é o padrão de quem TEM produto e a categoria não marcou setor — o
-- mesmo que o app faz. Quem não tem produto nenhum não cai aqui: cai no degrau
-- 3, que é cozinha.
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
    select ord                                  as pos,
           coalesce(e->>'nome', '')             as nome,
           coalesce(e->>'id', '')               as item_id
      from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) with ordinality as t(e, ord)
  ),
  -- Degrau 1: produto nosso com o mesmo nome (sem acento, sem caixa).
  por_produto as (
    select i.pos,
           (select c.setor
              from produtos p
              left join categorias c
                on c.empresa_id = p.empresa_id and c.nome = p.categoria
             where p.empresa_id = p_empresa
               and lower(unaccent(p.nome)) = lower(unaccent(i.nome))
             limit 1) as setor,
           exists (select 1 from produtos p
                    where p.empresa_id = p_empresa
                      and lower(unaccent(p.nome)) = lower(unaccent(i.nome))) as achou
      from item i
  ),
  -- Degrau 2: a categoria do iFood em que o item mora, vinculada a uma nossa.
  por_categoria as (
    select i.pos,
           (select c.setor
              from ifood_cardapio_item ci
              join ifood_categoria_vinculo v
                on v.merchant_id = ci.merchant_id
               and v.categoria_ifood_id = ci.categoria_id
              join categorias c on c.id = v.categoria_id
             where ci.merchant_id = p_merchant
               and ci.item_id = i.item_id
             limit 1) as setor,
           exists (select 1
                     from ifood_cardapio_item ci
                     join ifood_categoria_vinculo v
                       on v.merchant_id = ci.merchant_id
                      and v.categoria_ifood_id = ci.categoria_id
                    where ci.merchant_id = p_merchant
                      and ci.item_id = i.item_id) as achou
      from item i
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'nome',  i.nome,
             'id',    i.item_id,
             'setor', case
                        when pp.achou then pc_setor(pp.setor)
                        when pg.achou then pc_setor(pg.setor)
                        else 'cozinha'
                      end,
             'fonte', case when pp.achou then 'produto'
                           when pg.achou then 'categoria'
                           else 'desconhecido' end
           ) order by i.pos
         ), '[]'::jsonb)
    from item i
    join por_produto   pp on pp.pos = i.pos
    join por_categoria pg on pg.pos = i.pos;
$$;

revoke all on function public.resolver_setor_ifood(uuid, text, jsonb) from public;
grant execute on function public.resolver_setor_ifood(uuid, text, jsonb) to authenticated, service_role;

comment on function public.resolver_setor_ifood(uuid, text, jsonb) is
  'Setor de cada item de um pedido do iFood: produto por nome -> categoria vinculada -> cozinha (nao cadastrado).';
