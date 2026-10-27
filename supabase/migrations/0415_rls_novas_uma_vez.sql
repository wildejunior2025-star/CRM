-- Policies e view novas (de 0408 pra frente) voltaram a chamar current_perfil()
-- / current_empresa_id() SOLTOS, que leem profiles por LINHA examinada -- o
-- mesmo erro do travamento de 23/09 (mig 0279 tinha consertado as antigas).
-- Hoje as tabelas estao quase vazias e nao pesam; com muitas lojas usando o
-- estoque/cozinha, pesariam. Envolvidos em (select ...) -> InitPlan, uma vez
-- por consulta. Mesma regra: validado contando linhas por perfil antes/depois.
--
-- Achadas com:
--   select tablename, policyname from pg_policies
--    where (qual||with_check) ~ 'current_(empresa_id|perfil)\('
--      and (qual||with_check) !~ '\(\s*SELECT\s+current_';

set lock_timeout = '12s';

alter policy cat_aprendida_ler on categoria_item_aprendida
  using (empresa_id = (select current_empresa_id()));
alter policy cat_aprendida_escrever on categoria_item_aprendida
  using (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

alter policy consumo_fixo_rw on consumo_fixo
  using (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

alter policy "loja ve o encosto" on entregador_encosto_dia
  using (empresa_id = (select current_empresa_id()));
alter policy "loja lanca o encosto" on entregador_encosto_dia
  with check (empresa_id = (select current_empresa_id())
              and (select current_perfil()) = any (array['admin', 'vendedor']));
alter policy "loja muda o encosto" on entregador_encosto_dia
  using (empresa_id = (select current_empresa_id())
         and (select current_perfil()) = any (array['admin', 'vendedor']))
  with check (empresa_id = (select current_empresa_id())
              and (select current_perfil()) = any (array['admin', 'vendedor']));

alter policy req_itens_admin on requisicao_itens
  using ((select current_perfil()) = 'admin' and empresa_id = (select current_empresa_id()))
  with check ((select current_perfil()) = 'admin' and empresa_id = (select current_empresa_id()));
alter policy req_cozinha_admin on requisicoes_cozinha
  using ((select current_perfil()) = 'admin' and empresa_id = (select current_empresa_id()))
  with check ((select current_perfil()) = 'admin' and empresa_id = (select current_empresa_id()));

-- Saldo de insumos: mesmo filtro, e indice pro join dos movimentos (nao tinha).
create or replace view materia_prima_saldo as
 select mp.id as materia_prima_id, mp.nome, mp.unidade, mp.custo,
        coalesce(sum(case when mv.tipo = 'entrada' then mv.quantidade
                          when mv.tipo = 'saida' then - mv.quantidade
                          when mv.tipo = 'ajuste' then mv.quantidade else 0 end), 0) as quantidade_atual,
        mp.estoque_minimo,
        mp.categoria
   from materias_primas mp
   left join materia_prima_movimentos mv on mv.materia_prima_id = mp.id
  where mp.empresa_id = (select current_empresa_id())
  group by mp.id, mp.nome, mp.unidade, mp.custo, mp.estoque_minimo, mp.categoria;

create index if not exists materia_prima_movimentos_item_idx
  on materia_prima_movimentos (materia_prima_id);
