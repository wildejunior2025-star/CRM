// CPF ou CNPJ no mesmo campo, decidido pela quantidade de dígitos.
//
// POR QUE
// O cadastro exigia CNPJ. Só que boa parte das lojas pequenas — bar, espetinho,
// conveniência de bairro — opera no CPF do dono, sem CNPJ nenhum. Essas ficavam
// travadas logo no primeiro campo e não conseguiam nem criar a conta.
//
// Não dá pra simplesmente aceitar qualquer número: o documento é o que
// identifica a loja nas integrações (o iFood vincula o merchant pelo CNPJ) e na
// nota fiscal. Então continua validado — só que agora nas duas formas.
//
// COMO DECIDE
// Pela contagem de dígitos, que é o que o usuário pediu e é inequívoco:
//   até 11 dígitos → CPF   (000.000.000-00)
//   12 ou mais     → CNPJ  (00.000.000/0000-00)
// A máscara troca sozinha enquanto a pessoa digita, sem ela escolher nada.

export function tipoDocumento(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  return n.length > 11 ? 'cnpj' : 'cpf'
}

export function formatDocumento(v) {
  const n = String(v ?? '').replace(/\D/g, '').slice(0, 14)

  if (n.length <= 11) {
    return n
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2')
  }

  return n
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

// Dígitos verificadores do CPF (mesma conta da Receita).
export function cpfValido(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  if (n.length !== 11) return false
  if (/^(\d)\1{10}$/.test(n)) return false   // 111.111.111-11 e afins

  const dv = (qtd) => {
    let soma = 0
    let peso = qtd + 1
    for (let i = 0; i < qtd; i++) soma += Number(n[i]) * peso--
    const resto = (soma * 10) % 11
    return resto === 10 ? 0 : resto
  }

  return dv(9) === Number(n[9]) && dv(10) === Number(n[10])
}

export function cnpjValido(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  if (n.length !== 14) return false
  if (/^(\d)\1{13}$/.test(n)) return false

  const dv = (base) => {
    let peso = base.length - 7
    let soma = 0
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--
      if (peso < 2) peso = 9
    }
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }

  return dv(n.slice(0, 12)) === Number(n[12]) && dv(n.slice(0, 13)) === Number(n[13])
}

export function documentoValido(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  return n.length === 11 ? cpfValido(n) : cnpjValido(n)
}

// Mensagem de erro que diz o que está errado, não só "inválido".
// Número incompleto é o caso mais comum, e aí a pessoa precisa saber se faltam
// dígitos ou se o que ela digitou não bate.
export function erroDocumento(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  if (!n) return 'Informe o CPF ou o CNPJ da loja.'
  if (n.length < 11) return 'Número incompleto — CPF tem 11 dígitos e CNPJ tem 14.'
  if (n.length > 11 && n.length < 14) return 'CNPJ incompleto — faltam dígitos.'
  if (!documentoValido(n)) {
    return n.length === 11
      ? 'Esse CPF não confere. Confira os números.'
      : 'Esse CNPJ não confere. Confira os números.'
  }
  return null
}
