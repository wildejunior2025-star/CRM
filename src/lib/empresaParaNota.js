// Dados da empresa que vao no cupom fiscal (DANFE NFC-e impresso na termica).
// O endereco da nota e o do emitente: igual ao da loja, a nao ser que a loja emita
// por um CNPJ cadastrado em outro endereco (empresa_fiscal.emitente_*, mig 0459).
// Assim o papel bate com o que o XML mostra.
export async function empresaParaNota(supabase, empresaId) {
  const { data: emp } = await supabase.from('empresas')
    .select('nome, razao_social, cnpj, endereco, numero, bairro, cidade, estado').eq('id', empresaId).maybeSingle()
  if (!emp) return emp
  const { data: f } = await supabase.from('empresa_fiscal')
    .select('emitente_endereco, emitente_numero, emitente_bairro').eq('empresa_id', empresaId).maybeSingle()
  if (!f?.emitente_endereco) return emp
  return { ...emp, endereco: f.emitente_endereco, numero: f.emitente_numero ?? emp.numero, bairro: f.emitente_bairro ?? emp.bairro }
}
