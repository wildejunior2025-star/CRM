import { supabase } from './supabaseClient'

// Código de 4 dígitos que o cliente informa pra confirmar que recebeu.
//
// O ajuste é da plataforma (`configuracoes_plataforma.exigir_codigo_entrega`),
// mas TRÊS telas mexem nisso — o painel da loja, a lista de pedidos e o painel
// do entregador — e duas delas geravam o código sem nunca olhar o ajuste. Com
// ele desligado, o código continuava nascendo no despacho, e a tela de
// confirmação só olha se o pedido TEM código: resultado, a loja seguia sendo
// obrigada a digitar um código que ela tinha desligado.
//
// Por isso a leitura mora aqui. Quem for mexer numa quarta tela usa esta função
// e não repete o esquecimento.

// Ausente vale como LIGADO: é o comportamento histórico, e ficar sem o código
// por causa de uma linha que não existe seria pior que pedir à toa.
export async function exigeCodigoEntrega() {
  const { data } = await supabase
    .from('configuracoes_plataforma')
    .select('valor')
    .eq('chave', 'exigir_codigo_entrega')
    .maybeSingle()
  return data ? data.valor !== 'false' : true
}

// O código do despacho, ou null quando a loja desligou. Devolver null é o que
// desarma a confirmação lá na frente: sem código guardado, a tela não pede.
export function novoCodigoEntrega(exige) {
  return exige ? String(Math.floor(1000 + Math.random() * 9000)) : null
}
