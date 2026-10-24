-- ─────────────────────────────────────────────────────────────────────────────
-- 0387 — Pedido que JÁ ANDOU não ganha papel automático (nem de PC atrasado)
--
-- 24/10/2026, Agv Grill, 12:22: dois pedidos do iFood que chegaram às 11:16 e
-- 11:19 saíram DE NOVO na térmica da cozinha na hora em que o balcão despachou.
-- A cozinha refaz prato que já saiu pra entrega e ninguém fica sabendo.
--
-- É o mesmo caso de 23/10 (12:08, mesma loja), que eu já tinha corrigido DENTRO
-- do app (`STATUS_VIRA_PAPEL`, v42). Só que o PC da cozinha está na **v41** e
-- nunca atualizou — e a correção que mora no app não vale pra quem não atualiza.
--
-- Agora a regra vale também no banco, dentro da `reservar_impressao`: todo
-- caminho de impressão AUTOMÁTICA (app FWC v40+ e navegador do gestor) pergunta
-- "é a minha vez?" antes de imprimir, e pedido que já saiu da fila de preparo
-- ouve que não. Um PC velho deixa de imprimir papel atrasado sem precisar
-- atualizar.
--
-- A JANELA DE 5 MINUTOS existe por causa da venda de balcão: ela nasce
-- 'confirmado' e o atendente às vezes clica "Finalizar venda" em poucos
-- segundos, antes de o app ter recebido o aviso. Sem a folga, essa venda nunca
-- sairia no papel. Pedido recém-criado imprime seja qual for o status.
--
-- O botão 🖨️ de reimprimir não passa por aqui — segunda via continua saindo.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.reservar_impressao(
  p_pedido uuid,
  p_quem text default ''::text,
  p_papel text default 'tudo'::text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa uuid;
  v_origem  text;
  v_status  text;
  v_criado  timestamptz;
  v_papel   text := coalesce(nullif(trim(p_papel), ''), 'tudo');
begin
  select pd.empresa_id, pd.origem, pd.status, pd.created_at
    into v_empresa, v_origem, v_status, v_criado
    from pedidos_delivery pd where pd.id = p_pedido;
  if v_empresa is null then return false; end if;

  if v_empresa <> (select current_empresa_id())
     and coalesce((select current_perfil()), '') <> 'super_admin' then
    return false;
  end if;

  -- A loja desligou o cupom do balcão (mig 0386).
  if v_origem = 'balcao'
     and not coalesce((select e.imprimir_cupom_balcao from empresas e where e.id = v_empresa), true) then
    return false;
  end if;

  -- Pedido que já andou (pronto, despachado, entregue, cancelado) não vira
  -- papel sozinho. Mesma regra do app v42, agora valendo pra qualquer versão.
  if v_status not in ('aguardando', 'confirmado', 'em_preparo')
     and v_criado < now() - interval '5 minutes' then
    return false;
  end if;

  insert into impressao_dono (pedido_id, papel, empresa_id, quem)
  values (p_pedido, v_papel, v_empresa, left(coalesce(p_quem, ''), 60))
  on conflict (pedido_id, papel) do nothing;

  if random() < 0.02 then
    delete from impressao_dono where criado_em < now() - interval '2 days';
  end if;

  return found;
end;
$function$;
