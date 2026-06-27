-- =========================================================
-- Migration 0063 - Funcionalidades (módulos) liga/desliga por loja
-- =========================================================
-- O Super Admin liga/desliga cada funcionalidade do CRM por empresa, para
-- a loja só ver o que está habilitado (sem poluir a tela com módulos que
-- ela não usa, ex: delivery, serviço de mesa, WhatsApp).
--
-- Semântica: um módulo está ATIVO por padrão. Ele só fica oculto quando
-- gravado explicitamente como `false` em empresas.modulos. Assim as lojas
-- já existentes (modulos = {}) continuam com tudo ligado, sem migração de dados.
--   ex: { "delivery": false, "whatsapp": false }
-- =========================================================

alter table empresas
  add column if not exists modulos jsonb not null default '{}'::jsonb;

-- Trava: só o super_admin pode mudar quais módulos a loja enxerga.
-- O admin da loja continua atualizando a própria empresa (MinhaLoja: nome,
-- logo, delivery etc.), mas qualquer tentativa de alterar `modulos` é ignorada
-- (preserva o valor antigo) — impede a loja de religar pela API o que foi desligado.
create or replace function lock_empresa_modulos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_perfil() is distinct from 'super_admin' then
    new.modulos := old.modulos;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_lock_empresa_modulos on empresas;
create trigger trg_lock_empresa_modulos
  before update on empresas
  for each row
  execute function lock_empresa_modulos();
