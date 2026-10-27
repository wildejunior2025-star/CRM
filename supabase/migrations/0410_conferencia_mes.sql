-- 0410 — CONFERÊNCIA DO MÊS: o custo REAL da mercadoria contra o que as vendas PREVIAM
--
-- 27/10/2026, AGV Grill: o lucro do dia usa um custo ESTIMADO (ficha técnica / % do vendido) e a compra
-- paga não desconta do dia (descontaria 2x). Pra o dono saber se a estimativa está certa, uma vez por mês
-- se faz a conta de padaria:
--     consumo real = estoque no início + o que entrou (compras) − estoque no fim
-- e compara com o que as vendas previam. Se o real passa do previsto, ou o % de custo está baixo, ou há
-- desperdício/desvio — e a tela da Cozinha mostra em qual dia/pessoa.
--
-- Estoque valorizado no custo ATUAL do cadastro (custo médio). Serve pra conferir, não pra contabilidade.
-- Só o administrador da loja vê.

create or replace function conferencia_mes(p_ini date, p_fim date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_ini   timestamptz := (p_ini::timestamp) at time zone 'America/Sao_Paulo';
  v_fim   timestamptz := ((p_fim + 1)::timestamp) at time zone 'America/Sao_Paulo';
  r       jsonb;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja vê a conferência.';
  end if;

  with sinal as (
    select materia_prima_id as item, created_at,
           case tipo when 'entrada' then quantidade when 'saida' then -quantidade when 'ajuste' then quantidade else 0 end as q
      from materia_prima_movimentos where empresa_id = v_emp
  ), ins as (
    select coalesce(sum(s.q) filter (where s.created_at < v_ini) * m.custo, 0) as ini,
           coalesce(sum(s.q) filter (where s.created_at < v_fim) * m.custo, 0) as fim
      from materias_primas m left join sinal s on s.item = m.id
     where m.empresa_id = v_emp group by m.id, m.custo
  ), sinal_p as (
    select produto_id as item, created_at,
           case tipo when 'entrada' then quantidade when 'saida' then -quantidade when 'ajuste' then quantidade else 0 end as q
      from estoque_movimentos where empresa_id = v_emp
  ), prod as (
    select coalesce(sum(s.q) filter (where s.created_at < v_ini) * p.preco_custo, 0) as ini,
           coalesce(sum(s.q) filter (where s.created_at < v_fim) * p.preco_custo, 0) as fim
      from produtos p join sinal_p s on s.item = p.id
     where p.empresa_id = v_emp and coalesce(p.controla_estoque, true) group by p.id, p.preco_custo
  )
  select jsonb_build_object(
    'insumos_ini', round((select coalesce(sum(ini), 0) from ins), 2),
    'insumos_fim', round((select coalesce(sum(fim), 0) from ins), 2),
    'produtos_ini', round((select coalesce(sum(ini), 0) from prod), 2),
    'produtos_fim', round((select coalesce(sum(fim), 0) from prod), 2),
    -- o que ENTROU de verdade (qualquer porta: Lançar compra, entrada antiga, robô). A sobra que volta da cozinha não é compra.
    'compras_insumos', round((select coalesce(sum(coalesce(valor_total, quantidade * custo_unit, 0)), 0)
        from materia_prima_movimentos where empresa_id = v_emp and tipo = 'entrada'
         and created_at >= v_ini and created_at < v_fim and coalesce(observacao, '') not like 'Sobra da cozinha%'), 2),
    'compras_produtos', round((select coalesce(sum(coalesce(valor_total, quantidade * custo_unit, 0)), 0)
        from estoque_movimentos where empresa_id = v_emp and tipo = 'entrada' and motivo = 'compra'
         and created_at >= v_ini and created_at < v_fim), 2),
    -- o que as vendas PREVIAM: pratos (ficha / % do vendido) + revenda (saída por venda × custo)
    'previsto_pratos', round((select coalesce(sum(custo), 0) from custo_vendido_periodo(v_ini, v_fim, v_emp)), 2),
    'vendido_pratos', round((select coalesce(sum(valor_vendido), 0) from custo_vendido_periodo(v_ini, v_fim, v_emp)), 2),
    'previsto_revenda', round((select coalesce(sum(m.quantidade * coalesce(p.preco_custo, 0)), 0)
        from estoque_movimentos m join produtos p on p.id = m.produto_id
       where m.empresa_id = v_emp and m.tipo = 'saida' and m.motivo = 'venda'
         and m.created_at >= v_ini and m.created_at < v_fim), 2),
    'cozinha_entregue', round((select coalesce(sum(valor_total), 0) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim), 2),
    'cozinha_usado', round((select coalesce(sum(valor_usado), 0) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim and status = 'fechada'), 2),
    'cozinha_sem_sobra', (select count(*) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim and status = 'aberta'),
    -- produto que se controla no estoque mas está com custo zero: o estoque dele vale R$ 0 e o consumo real sai subestimado
    'produtos_sem_custo', (select count(*) from produtos p where p.empresa_id = v_emp and coalesce(p.controla_estoque, true)
        and coalesce(p.preco_custo, 0) = 0 and exists (select 1 from estoque_movimentos e where e.produto_id = p.id)),
    'insumos_sem_custo', (select count(*) from materias_primas m where m.empresa_id = v_emp and coalesce(m.custo, 0) = 0
        and exists (select 1 from materia_prima_movimentos e where e.materia_prima_id = m.id))
  ) into r;
  return r;
end $$;

revoke all on function conferencia_mes(date, date) from public, anon;
grant execute on function conferencia_mes(date, date) to authenticated;
