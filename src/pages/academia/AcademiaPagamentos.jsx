import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { FORMAS, hojeIso, cancelarPagamento, dinheiro, dataBr } from '../../lib/academiaPagamento'

// academia.fwcinter.com/pagamentos — quem pagou, quanto entrou e o fechamento
// do dia. Cada linha vem do botão "Renovar" da lista de alunos (mig 0294).

const nomeForma = id => FORMAS.find(f => f.id === id)?.nome || id

function primeiroDiaDoMes() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

export default function AcademiaPagamentos() {
  const { empresa } = useAuth()
  const [de, setDe] = useState(hojeIso())
  const [ate, setAte] = useState(hojeIso())
  const [pagamentos, setPagamentos] = useState([])
  const [mes, setMes] = useState({ total: 0, quantos: 0 })
  const [carregando, setCarregando] = useState(true)

  const carregar = useCallback(async () => {
    setCarregando(true)
    const [{ data: lista }, { data: doMes }] = await Promise.all([
      supabase
        .from('academia_pagamentos')
        .select('*, academia_alunos(nome, matricula)')
        .eq('empresa_id', empresa.id)
        .gte('data', de)
        .lte('data', ate)
        .order('criado_em', { ascending: false }),
      supabase
        .from('academia_pagamentos')
        .select('valor, cancelado')
        .eq('empresa_id', empresa.id)
        .gte('data', primeiroDiaDoMes()),
    ])
    setPagamentos(lista || [])
    const validos = (doMes || []).filter(p => !p.cancelado)
    setMes({ total: validos.reduce((s, p) => s + Number(p.valor), 0), quantos: validos.length })
    setCarregando(false)
  }, [empresa.id, de, ate])

  useEffect(() => { carregar() }, [carregar])

  async function cancelar(p) {
    if (!window.confirm(`Cancelar o pagamento de ${p.academia_alunos?.nome}? O vencimento volta para ${dataBr(p.vencimento_antes)}.`)) return
    await cancelarPagamento(p)
    carregar()
  }

  const validos = pagamentos.filter(p => !p.cancelado)
  const total = validos.reduce((s, p) => s + Number(p.valor), 0)
  // Pagamento dividido entra em cada forma com a parte dela: quem paga
  // metade no dinheiro e metade no cartao soma R$ 30 em cada, nao R$ 60
  // num so.
  const quanto = (p, id) => (p.partes
    ? p.partes.filter(x => x.forma === id).reduce((s, x) => s + Number(x.valor || 0), 0)
    : (p.forma === id ? Number(p.valor) : 0))
  const porForma = FORMAS
    .map(f => ({ ...f, total: validos.reduce((s, p) => s + quanto(p, f.id), 0) }))
    .filter(f => f.total > 0)

  return (
    <div>
      <div className="ac-linha-titulo">
        <h2>Pagamentos</h2>
        <button className="btn btn-secondary btn-sm" onClick={() => { setDe(hojeIso()); setAte(hojeIso()) }}>Hoje</button>
      </div>

      <div className="ac-barra">
        <label className="ac-campo-data">De<input type="date" value={de} onChange={e => setDe(e.target.value)} /></label>
        <label className="ac-campo-data">Até<input type="date" value={ate} onChange={e => setAte(e.target.value)} /></label>
      </div>

      <div className="ac-resumo">
        <div className="ac-resumo-item destaque">
          <span>{de === ate ? (de === hojeIso() ? 'Hoje' : dataBr(de)) : 'No período'}</span>
          <strong>{dinheiro(total)}</strong>
          <small>{validos.length} mensalidade{validos.length === 1 ? '' : 's'}</small>
        </div>
        <div className="ac-resumo-item">
          <span>No mês</span>
          <strong>{dinheiro(mes.total)}</strong>
          <small>{mes.quantos} mensalidade{mes.quantos === 1 ? '' : 's'}</small>
        </div>
        {porForma.map(f => (
          <div key={f.id} className="ac-resumo-item">
            <span>{f.nome}</span>
            <strong>{dinheiro(f.total)}</strong>
          </div>
        ))}
      </div>

      {carregando ? <p className="ac-muted">Carregando...</p> : pagamentos.length === 0 ? (
        <p className="ac-muted">Nenhuma mensalidade recebida nesse período.</p>
      ) : (
        <div className="ac-tabela-caixa">
          <table className="ac-tabela">
            <thead>
              <tr>
                <th>Data</th>
                <th>Matrícula</th>
                <th>Aluno</th>
                <th>Forma</th>
                <th>Passou a vencer</th>
                <th className="ac-num">Valor</th>
                <th className="ac-col-acoes"></th>
              </tr>
            </thead>
            <tbody>
              {pagamentos.map(p => (
                <tr key={p.id} className={p.cancelado ? 'ac-cancelado' : ''}>
                  <td data-rotulo="Data" className="ac-num">
                    {dataBr(p.data)}
                    <small className="ac-muted"> {new Date(p.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>
                  </td>
                  <td data-rotulo="Matrícula" className="ac-num">{p.academia_alunos?.matricula || '—'}</td>
                  <td data-rotulo="Aluno"><strong>{p.academia_alunos?.nome}</strong></td>
                  <td data-rotulo="Forma">
                    {p.partes
                      ? p.partes.map(x => `${nomeForma(x.forma)} ${dinheiro(x.valor)}`).join(' + ')
                      : nomeForma(p.forma)}{p.meses > 1 ? ` · ${p.meses} meses` : ''}
                    {p.cancelado && <span className="ac-status ac-vencido" style={{ marginLeft: 6 }}>Cancelado</span>}
                  </td>
                  <td data-rotulo="Passou a vencer" className="ac-num">{dataBr(p.vencimento_depois)}</td>
                  <td data-rotulo="Valor" className="ac-num"><strong>{dinheiro(p.valor)}</strong></td>
                  <td className="ac-col-acoes">
                    {!p.cancelado && (
                      <button className="btn btn-secondary btn-sm" onClick={() => cancelar(p)}>Cancelar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
