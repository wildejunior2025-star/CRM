-- VENDEDOR PODE LANÇAR ENTRADA DE ESTOQUE (e registrar perda).
--
-- O buraco: `estoque_movimentos` tinha UMA policy, "Admin gerencia movimentos
-- de estoque", só pra admin. Mas:
--   * a rota /entrada-estoque está liberada pra ['admin','vendedor'] desde que
--     nasceu — pro vendedor ela nunca funcionou, batia no RLS calada;
--   * o botão "+ Estoque" no Catálogo do gestor (10/10) herdou o mesmo
--     problema: o atendente via o botão e não conseguia salvar;
--   * a Baixa parecia funcionar porque `custos_imprevistos` aceita qualquer
--     perfil da empresa — mas só em produto SEM controle de estoque. Em quem
--     controla, imprevisto_registrar tenta a saída e morre aqui.
--
-- Quem recebe a carga é o funcionário, não o dono. Era ele que precisava
-- lançar e era justamente ele que não podia.
--
-- O QUE O VENDEDOR GANHA, e só isso:
--   * ENTRADA — somar o que chegou. Somar estoque não esconde furo.
--   * SAÍDA com motivo 'imprevisto' — a baixa por quebra/perda, que passa pela
--     imprevisto_registrar e exige a descrição do que aconteceu.
-- Continua FORA do alcance dele: saída livre, ajuste de inventário, alterar e
-- apagar movimento. Isso é do dono, porque é o que esconde furo de caixa.

-- Ver o saldo: quem lança precisa enxergar o que já tem, senão lança no escuro.
DROP POLICY IF EXISTS "Equipe ve movimentos de estoque" ON public.estoque_movimentos;
CREATE POLICY "Equipe ve movimentos de estoque"
  ON public.estoque_movimentos
  FOR SELECT
  USING (empresa_id = (SELECT current_empresa_id()));

DROP POLICY IF EXISTS "Vendedor lanca entrada e perda" ON public.estoque_movimentos;
CREATE POLICY "Vendedor lanca entrada e perda"
  ON public.estoque_movimentos
  FOR INSERT
  WITH CHECK (
    empresa_id = (SELECT current_empresa_id())
    AND (SELECT current_perfil()) = 'vendedor'
    AND (
      tipo = 'entrada'
      OR (tipo = 'saida' AND motivo = 'imprevisto')
    )
  );
