-- Fila de disparo de campanha (robô de aviso pelo WhatsApp).
--
-- Mandar em rajada é o que derruba número: foi assim que o WhatsApp da Estação
-- ficou 5h sem poder puxar conversa (21/08/2026). Aqui cada mensagem tem hora
-- marcada, e quem decide a próxima hora é o worker — intervalo aleatório, teto
-- por hora e parada na primeira recusa.
--
-- A fila guarda a mensagem JÁ PRONTA (nome trocado, link do cliente dentro).
-- Assim o que foi enviado fica registrado exatamente como saiu.

CREATE TABLE IF NOT EXISTS public.campanha_fila (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  campanha       text NOT NULL,              -- agrupa o lote ("estacao_nome_novo")
  nome           text,                       -- só para conferir na tela
  telefone       text NOT NULL,              -- só dígitos, com o 55
  mensagem       text NOT NULL,
  instancia      text NOT NULL,              -- instância Evolution que envia
  status         text NOT NULL DEFAULT 'pendente',  -- pendente | enviado | falhou | cancelado
  erro           text,
  agendado_para  timestamptz NOT NULL DEFAULT now(),
  enviado_em     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- O worker busca sempre "o próximo pendente que já venceu"
CREATE INDEX IF NOT EXISTS campanha_fila_proximo_idx
  ON public.campanha_fila (campanha, status, agendado_para);

-- Nunca duas mensagens da mesma campanha para o mesmo número
CREATE UNIQUE INDEX IF NOT EXISTS campanha_fila_sem_repetido_idx
  ON public.campanha_fila (campanha, telefone);

ALTER TABLE public.campanha_fila ENABLE ROW LEVEL SECURITY;

-- Só o dono da loja enxerga a fila dela. O worker usa service_role e passa direto.
DROP POLICY IF EXISTS campanha_fila_da_empresa ON public.campanha_fila;
CREATE POLICY campanha_fila_da_empresa ON public.campanha_fila
  FOR SELECT TO authenticated
  USING (empresa_id IN (SELECT empresa_id FROM public.profiles WHERE id = auth.uid()));
