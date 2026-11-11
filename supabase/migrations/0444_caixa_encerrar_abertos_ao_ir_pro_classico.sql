-- Voltar do modo "um dia por vez" para o clássico (abrir/fechar na mão).
--
-- No modo-dia ninguém fecha o `caixas`: o caixa aberto fica parado, e as vendas
-- seguem apontando pra ele (Agv Grill: aberto desde 26/10, R$ 39 mil de 16 dias).
-- Ao ligar o clássico ele aparecia como "o caixa de agora" e misturava tudo.
--
-- Esta função só MARCA esse caixa como fechado, pra o clássico começar limpo no
-- "Abrir caixa". NÃO apaga nada (o fechar_caixa apaga caixa vazio — de propósito
-- não é usado aqui), NÃO mexe em venda, pagamento nem movimento, e os dias
-- conferidos em `caixa_dia` ficam intactos e continuam aparecendo na tela.
create or replace function public.caixa_encerrar_abertos_ao_ir_pro_classico()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if current_perfil() <> 'admin' then
    raise exception 'Só o dono pode mudar o modo do caixa';
  end if;

  update caixas
     set status = 'fechado',
         fechado_em = now(),
         fechado_por = auth.uid(),
         observacoes_fechamento = coalesce(observacoes_fechamento || E'\n', '')
           || 'Encerrado automaticamente ao voltar pro modo clássico (era o caixa parado do modo "um dia por vez").'
   where empresa_id = current_empresa_id()
     and status = 'aberto';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.caixa_encerrar_abertos_ao_ir_pro_classico() from public;
grant execute on function public.caixa_encerrar_abertos_ao_ir_pro_classico() to authenticated;
