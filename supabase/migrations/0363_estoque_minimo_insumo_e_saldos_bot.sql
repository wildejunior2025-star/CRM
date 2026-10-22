-- 0363 — ESTOQUE MÍNIMO NO INSUMO + SALDOS PARA O ROBÔ DO WHATSAPP
--
-- 1) Matéria-prima (insumo) passa a ter estoque mínimo, igual ao produto. Sem isso o insumo
--    (pão, carne, queijo) nunca avisava que estava acabando.
-- 2) A view materia_prima_saldo expõe o mínimo (coluna nova no FIM, senão o CREATE OR REPLACE quebra).
-- 3) estoque_bot_saldos(empresa): saldo de produtos E insumos de UMA loja numa consulta só. O robô
--    usa isso pra listar estoque e achar o que está baixo SEM chamar IA (custo zero). As views
--    filtram por current_empresa_id(), que não existe quando quem consulta é o robô (service_role).
-- 4) assistente_acoes ganha o tipo 'definir_minimo' (o robô muda só o estoque mínimo de um item).

alter table materias_primas add column if not exists estoque_minimo numeric not null default 0;

create or replace view public.materia_prima_saldo as
 select mp.id as materia_prima_id,
    mp.nome,
    mp.unidade,
    mp.custo,
    coalesce(sum(
        case
            when mv.tipo = 'entrada'::text then mv.quantidade
            when mv.tipo = 'saida'::text then - mv.quantidade
            when mv.tipo = 'ajuste'::text then mv.quantidade
            else 0::numeric
        end), 0::numeric) as quantidade_atual,
    mp.estoque_minimo
   from materias_primas mp
     left join materia_prima_movimentos mv on mv.materia_prima_id = mp.id
  where mp.empresa_id = current_empresa_id()
  group by mp.id, mp.nome, mp.unidade, mp.custo, mp.estoque_minimo;

grant select on public.materia_prima_saldo to authenticated;

create or replace function public.estoque_bot_saldos(p_empresa_id uuid)
returns table (tipo text, id uuid, nome text, categoria text, unidade text, saldo numeric, minimo numeric, controla boolean)
language sql stable security definer set search_path = public as $$
  select 'produto'::text, p.id, p.nome, p.categoria, 'un'::text,
         coalesce(sum(case m.tipo when 'entrada' then m.quantidade when 'saida' then -m.quantidade when 'ajuste' then m.quantidade else 0 end), 0),
         p.estoque_minimo, p.controla_estoque
    from produtos p
    left join estoque_movimentos m on m.produto_id = p.id
   where p.empresa_id = p_empresa_id and p.ativo and p.arquivado_em is null
   group by p.id, p.nome, p.categoria, p.estoque_minimo, p.controla_estoque
  union all
  select 'insumo'::text, mp.id, mp.nome, 'Insumos'::text, mp.unidade,
         coalesce(sum(case mv.tipo when 'entrada' then mv.quantidade when 'saida' then -mv.quantidade when 'ajuste' then mv.quantidade else 0 end), 0),
         mp.estoque_minimo, true
    from materias_primas mp
    left join materia_prima_movimentos mv on mv.materia_prima_id = mp.id
   where mp.empresa_id = p_empresa_id and mp.ativo
   group by mp.id, mp.nome, mp.unidade, mp.estoque_minimo;
$$;
revoke all on function public.estoque_bot_saldos(uuid) from public, anon, authenticated;
grant execute on function public.estoque_bot_saldos(uuid) to service_role;

alter table assistente_acoes drop constraint if exists assistente_acoes_tipo_check;
alter table assistente_acoes add constraint assistente_acoes_tipo_check
  check (tipo in ('cadastrar_produto','mudar_preco','taxa_entrega_fixa','pedido_minimo','ajustar_tabela_km','definir_minimo'));
