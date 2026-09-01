-- =========================================================
-- 0218: quem chegou no endereço e não fechou — nome, telefone e CEP
-- =========================================================
-- O funil (mig 0216) diz QUANTOS pararam no cadastro, mas não QUEM. Na CD Bom,
-- em 01/09/2026, cinco visitas chegaram no endereço e nenhuma fechou — e três
-- delas tinham a MESMA sacola de R$ 47,80 em uma hora, ou seja, quase certamente
-- a mesma pessoa tentando de novo e não conseguindo. Sem o CEP não dá pra saber
-- se ela mora fora do raio de entrega, e sem o telefone não dá pra perguntar.
--
-- Fica numa tabela SEPARADA do funil de propósito: o funil é número, e o lojista
-- lê; isto é dado de pessoa, e por ora só o super admin lê. Quando decidirmos
-- liberar pro lojista, é uma linha nesta política — o resto já está pronto.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.loja_funil_contato (
  sessao        text PRIMARY KEY,
  empresa_id    uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nome          text,
  telefone      text,
  cep           text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loja_funil_contato_empresa_data_idx
  ON public.loja_funil_contato (empresa_id, created_at DESC);

ALTER TABLE public.loja_funil_contato ENABLE ROW LEVEL SECURITY;

-- Ninguém escreve direto: quem grava é a função abaixo. Assim o visitante
-- anônimo não ganha permissão de mexer na tabela inteira.
REVOKE ALL ON public.loja_funil_contato FROM anon, authenticated;

-- Leitura: só super admin POR ENQUANTO. Pra liberar pro lojista um dia, é
-- acrescentar `OR empresa_id = current_empresa_id()` aqui.
DROP POLICY IF EXISTS "Super admin ve contato do funil" ON public.loja_funil_contato;
CREATE POLICY "Super admin ve contato do funil" ON public.loja_funil_contato
  FOR SELECT USING (current_perfil() = 'super_admin');
GRANT SELECT ON public.loja_funil_contato TO authenticated;

-- Grava o que o cliente já digitou no checkout. Chamada várias vezes conforme
-- ele preenche: cada chamada só ACRESCENTA o que veio preenchido, nunca apaga
-- o que já estava (ele digita o nome, depois o telefone, depois o CEP).
CREATE OR REPLACE FUNCTION public.funil_contato(
  p_empresa  uuid,
  p_sessao   text,
  p_nome     text DEFAULT NULL,
  p_telefone text DEFAULT NULL,
  p_cep      text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Sessão é um uuid gerado no navegador. Barra lixo antes de escrever.
  IF p_sessao IS NULL OR length(p_sessao) NOT BETWEEN 8 AND 64 THEN RETURN; END IF;

  INSERT INTO public.loja_funil_contato (sessao, empresa_id, nome, telefone, cep)
  VALUES (
    p_sessao, p_empresa,
    nullif(btrim(left(p_nome, 120)), ''),
    nullif(btrim(left(p_telefone, 20)), ''),
    nullif(btrim(left(p_cep, 12)), '')
  )
  ON CONFLICT (sessao) DO UPDATE SET
    nome          = coalesce(excluded.nome,     public.loja_funil_contato.nome),
    telefone      = coalesce(excluded.telefone, public.loja_funil_contato.telefone),
    cep           = coalesce(excluded.cep,      public.loja_funil_contato.cep),
    atualizado_em = now();
END $$;

GRANT EXECUTE ON FUNCTION public.funil_contato(uuid, text, text, text, text) TO anon, authenticated;

COMMENT ON TABLE public.loja_funil_contato IS
  'Contato de quem chegou no cadastro da Loja Online e nao fechou pedido. Leitura so do super admin (por ora).';
