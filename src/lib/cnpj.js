// Máscara e validação de CNPJ.
//
// O CNPJ é obrigatório no cadastro de loja porque é ele que identifica a loja
// nas integrações (iFood pede o CNPJ pra vincular o merchant ao nosso app).

export function formatCnpj(v) {
  return String(v ?? '').replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
    .slice(0, 18)
}

// Dígitos verificadores (mesma conta que a Receita usa).
export function cnpjValido(v) {
  const n = String(v ?? '').replace(/\D/g, '')
  if (n.length !== 14) return false
  if (/^(\d)\1{13}$/.test(n)) return false   // 00.000.000/0000-00 e afins

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
