-- SEGUNDA TENTATIVA, MAIS SOLTA (09/10/2026)
--
-- O cliente mandou áudio: "quais o burguer que tem aí?". A loja chama os dela
-- de "Braseiro Bacon", "Braseiro Cupim", na categoria "Hambúrgueres
-- Artesanais" — nenhum COMEÇA com "burguer", e o robô ficou mudo.
--
-- Então: a primeira passada continua exigindo começo de palavra (é ela que
-- impede "coca" de achar "paçoca"). Só quando ela não acha NADA é que vem a
-- segunda, que aceita o termo no meio da palavra — e só pra termo com 5+
-- letras, que é o que separa "burguer" dentro de "hambúrguer" de "coca"
-- dentro de "paçoca".
create or replace function public.buscar_produto_cardapio(
  p_empresa uuid,
  p_termo   text,
  p_limite  int default 3,
  p_solto   boolean default false
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
  with agora as (select (now() at time zone 'America/Fortaleza') as ts),
  alvo as (
    select case when p_solto then '' else '(^|[^a-z0-9])' end ||
           regexp_replace(unaccent(lower(btrim(p_termo))), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') as re
  )
  select p.id, p.nome, coalesce(p.preco_venda, 0),
         nullif(p.preco_promocional, 0), p.faixas_preco,
         p.categoria, p.embalagem, p.descricao
  from produtos p
  cross join agora a
  cross join alvo
  left join categorias c
    on c.empresa_id = p.empresa_id and c.nome = p.categoria
  where p.empresa_id = p_empresa
    and p.ativo
    and p.disponivel_delivery
    and p.arquivado_em is null
    and coalesce(p.preco_venda, 0) > 0
    and length(btrim(p_termo)) >= 3
    and (not p_solto or length(btrim(p_termo)) >= 5)
    and (
      unaccent(lower(p.nome)) ~ alvo.re
      or unaccent(lower(coalesce(p.categoria, ''))) ~ alvo.re
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
                  else a.ts::time >= c.hora_inicio or a.ts::time < c.hora_fim
             end
        )
      )
    )
  order by (unaccent(lower(p.nome)) ~ alvo.re) desc,
           greatest(
             similarity(unaccent(lower(p.nome)), unaccent(lower(btrim(p_termo)))),
             similarity(unaccent(lower(coalesce(p.categoria, ''))), unaccent(lower(btrim(p_termo)))) * 0.9
           ) desc,
           length(p.nome) asc
  limit greatest(1, least(p_limite, 20));
$$;

grant execute on function public.buscar_produto_cardapio(uuid, text, int, boolean) to anon, authenticated, service_role;
