-- Migration 0033: Adiciona coluna last_heartbeat_at em empresas
-- Usada pelo PainelPedidos para sinalizar que o painel está ativo (online).
-- O portal exibe "Loja aberta" somente se o heartbeat chegou há menos de 2 minutos.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
