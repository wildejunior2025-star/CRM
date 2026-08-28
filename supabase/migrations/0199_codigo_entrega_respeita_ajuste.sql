-- Código de entrega: o gatilho do banco passa a respeitar o interruptor.
--
-- O interruptor (Super Admin → Configurações → "🛵 Código de entrega", que grava
-- em configuracoes_plataforma.exigir_codigo_entrega) estava desligado desde
-- julho — e mesmo assim TODA loja continuava sendo obrigada a digitar o código
-- na hora de confirmar a entrega.
--
-- O motivo estava aqui: este gatilho carimbava um código em todo pedido no
-- INSERT, sem nunca olhar o ajuste. A tela de confirmação não consulta o
-- interruptor, ela só pergunta "esse pedido tem código?" — e tinha sempre.
-- Desligar o botão não desligava nada.
--
-- Agora o gatilho lê o ajuste. Com ele desligado o pedido nasce sem código, e
-- aí a tela não pede. Ligando de novo no Super Admin, o código volta sozinho —
-- é o que vai acontecer quando existir o app próprio de motoqueiro.
--
-- O iFood não passa por aqui: ele exige o código DELE (ifood_requer_codigo),
-- validado na API do iFood, e continua igual.

CREATE OR REPLACE FUNCTION public.gerar_codigo_entrega()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  exige boolean;
BEGIN
  -- Linha ausente vale como LIGADO: é o comportamento histórico, e ficar sem o
  -- código por causa de uma linha que não existe seria pior que gerar à toa.
  -- Mesma regra que o app usa em src/lib/codigoEntrega.js.
  SELECT COALESCE(
    (SELECT valor <> 'false' FROM public.configuracoes_plataforma
      WHERE chave = 'exigir_codigo_entrega'),
    true
  ) INTO exige;

  IF exige AND NEW.codigo_entrega IS NULL THEN
    NEW.codigo_entrega := LPAD(FLOOR(RANDOM() * 10000)::text, 4, '0');
  END IF;

  RETURN NEW;
END;
$function$;
