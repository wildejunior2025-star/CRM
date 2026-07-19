-- =========================================================
-- 0108: Ficha Técnica também pode vincular a um COMPLEMENTO
-- =========================================================
-- Além do produto do catálogo, muita coisa é vendida como complemento
-- (feijão, arroz, farofa...). Aqui a ficha pode apontar pra uma opção de
-- complemento e usar o preço do adicional pra calcular a margem.
-- Só um dos dois vínculos é usado por vez (produto_id OU complemento_opcao_id).
-- =========================================================

ALTER TABLE public.fichas_tecnicas
  ADD COLUMN IF NOT EXISTS complemento_opcao_id uuid
    REFERENCES complemento_opcoes(id) ON DELETE SET NULL;
