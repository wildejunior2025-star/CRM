// Comparação de texto pra busca: sem acento, sem caixa, sem espaço sobrando.
//
// Quem digita rápido no balcão não põe acento — escreve "camarao", "acai",
// "pao". Comparando o texto cru, "camarao" não acha "Camarão" e o vendedor
// conclui que o produto não está cadastrado.
//
// A conta é sempre a mesma dos dois lados: normaliza o que está no cadastro e
// normaliza o que foi digitado.
export const semAcento = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** O texto do cadastro contém o que foi digitado, ignorando acento e caixa? */
export const combina = (texto, busca) => semAcento(texto).includes(semAcento(busca))
