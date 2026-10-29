import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { rotuloComanda } from '../lib/comanda'
import { valesAtivos } from '../lib/constants'

// EDITAR UMA CONTA JÁ FECHADA (mig 0426, 29/10/2026)
//
// O dono fecha a mesa e só depois vê que lançou o produto errado, ou o cliente
// volta pra devolver um item estragado. Aqui ele mexe na lista de itens da conta
// e o banco (editar_conta_fechada) acerta o resto PELA DIFERENÇA: estoque,
// insumos, venda e dinheiro. A diferença entra como pagamento novo, HOJE —
// negativo quando a loja devolve — e o pagamento antigo fica onde estava.
//
// A conta que aparece aqui é uma ESTIMATIVA da tela; quem fecha o número é o
// banco, com a mesma regra de taxa do fechamento.

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

const FORMAS_DIF = [['dinheiro', 'Dinheiro'], ['pix', 'PIX'], ['credito', 'Crédito'], ['debito', 'Débito'], ['cartao', 'Cartão']]

export default function EditarContaFechada({ comanda, empresa, onFechar, onSalvo }) {
  const [itens, setItens] = useState(() => (comanda.comanda_itens ?? []).map(i => ({
    chave: i.id,
    id: i.id,
    produto_id: i.produto_id,
    nome: i.nome,
    quantidade: String(Number(i.quantidade)),
    preco: String(Number(i.preco_unitario)).replace('.', ','),
    isento: !!i.isento_taxa,
  })))
  const [catalogo, setCatalogo] = useState(null)
  const [busca, setBusca] = useState('')
  const [avulso, setAvulso] = useState(null) // { nome, preco } quando está inventando item
  const ehFiado = comanda.forma_pagamento === 'fiado'
  const formaUnica = !['dividido', 'fiado'].includes(comanda.forma_pagamento) ? comanda.forma_pagamento : null
  const [forma, setForma] = useState(formaUnica)
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    let vivo = true
    supabase.from('estoque_catalogo')
      .select('produto_id, nome, preco_venda, vende_salao')
      .eq('empresa_id', comanda.empresa_id)
      .order('nome')
      .limit(1000)
      .then(({ data }) => { if (vivo) setCatalogo((data ?? []).filter(p => p.vende_salao !== false)) })
    return () => { vivo = false }
  }, [comanda.empresa_id])

  const achados = useMemo(() => {
    const q = semAcento(busca.trim())
    if (!q || !catalogo) return []
    return catalogo.filter(p => semAcento(p.nome).includes(q)).slice(0, 8)
  }, [busca, catalogo])

  // Mesma regra do fechamento: a taxa de % foi cobrada? Se foi, recalcula em
  // cima da base nova; a gorjeta à parte fica como estava.
  const conta = useMemo(() => {
    const pct = Number(empresa?.taxa_servico_pct ?? 10)
    const baseAntes = (comanda.comanda_itens ?? [])
      .filter(i => !i.isento_taxa)
      .reduce((s, i) => s + Number(i.preco_unitario) * Number(i.quantidade), 0)
    const taxaPctAntes = Math.round(baseAntes * pct) / 100
    const taxaAntes = Number(comanda.taxa_servico || 0)
    const aplicou = baseAntes > 0 && taxaPctAntes > 0 && taxaAntes >= taxaPctAntes - 0.01
    const gorjeta = Math.max(taxaAntes - (aplicou ? taxaPctAntes : 0), 0)
    const sub = itens.reduce((s, i) => s + num(i.preco) * num(i.quantidade), 0)
    const base = itens.filter(i => !i.isento).reduce((s, i) => s + num(i.preco) * num(i.quantidade), 0)
    const taxa = (aplicou ? Math.round(base * pct) / 100 : 0) + gorjeta
    const total = Math.round((sub + taxa) * 100) / 100
    return { sub, taxa, total, dif: Math.round((total - Number(comanda.total || 0)) * 100) / 100 }
  }, [itens, comanda, empresa])

  const mudou = useMemo(() => {
    const antes = comanda.comanda_itens ?? []
    if (itens.length !== antes.length || itens.some(i => !i.id)) return true
    return itens.some(i => {
      const a = antes.find(x => x.id === i.id)
      return !a || num(i.quantidade) !== Number(a.quantidade) || Math.round(num(i.preco) * 100) !== Math.round(Number(a.preco_unitario) * 100)
    })
  }, [itens, comanda])

  function mexer(chave, campo, valor) {
    setItens(prev => prev.map(i => i.chave === chave ? { ...i, [campo]: valor } : i))
    setErro(null)
  }
  function somar(chave, delta) {
    setItens(prev => prev.map(i => i.chave === chave
      ? { ...i, quantidade: String(Math.max(1, Math.round((num(i.quantidade) + delta) * 1000) / 1000)) }
      : i))
    setErro(null)
  }
  function tirar(chave) {
    setItens(prev => prev.filter(i => i.chave !== chave))
    setErro(null)
  }
  function porDoCatalogo(p) {
    setItens(prev => [...prev, {
      chave: 'novo-' + Date.now() + Math.random(),
      id: null, produto_id: p.produto_id, nome: p.nome,
      quantidade: '1', preco: String(Number(p.preco_venda || 0)).replace('.', ','), isento: false,
    }])
    setBusca('')
    setErro(null)
  }
  function porAvulso() {
    const nome = (avulso?.nome ?? '').trim()
    if (!nome || num(avulso?.preco) <= 0) { setErro('Item avulso precisa de nome e preço.'); return }
    setItens(prev => [...prev, {
      chave: 'novo-' + Date.now() + Math.random(),
      id: null, produto_id: null, nome, quantidade: '1', preco: avulso.preco, isento: false,
    }])
    setAvulso(null)
    setErro(null)
  }

  async function salvar() {
    if (itens.length === 0) { setErro('A conta ficaria vazia. Pra desfazer tudo, use "Cancelar a conta".'); return }
    if (itens.some(i => num(i.quantidade) <= 0)) { setErro('Tem item com quantidade zero.'); return }
    if (!ehFiado && Math.abs(conta.dif) >= 0.005 && !forma) {
      setErro(`Escolha em qual forma a diferença foi ${conta.dif > 0 ? 'cobrada' : 'devolvida'}.`)
      return
    }
    setSalvando(true)
    setErro(null)
    const { data, error } = await supabase.rpc('editar_conta_fechada', {
      p_comanda_id: comanda.id,
      p_itens: itens.map(i => ({
        id: i.id || undefined,
        produto_id: i.id ? undefined : (i.produto_id || undefined),
        nome: i.nome,
        quantidade: num(i.quantidade),
        preco_unitario: Math.round(num(i.preco) * 100) / 100,
      })),
      p_forma_diferenca: ehFiado ? null : forma,
      p_motivo: motivo.trim() || null,
    })
    setSalvando(false)
    if (error) { setErro(error.message || 'Não consegui salvar. Tente de novo.'); return }
    onSalvo?.(data)
  }

  const inp = {
    padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box',
  }
  const btnPeq = {
    width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text)', fontWeight: 800, fontSize: 16, cursor: 'pointer', flex: '0 0 auto',
  }

  return (
    <div onClick={onFechar}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 150,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 520, maxHeight: '92dvh', overflowY: 'auto',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 18 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>✏️ Editar conta · {comanda.numero_mesa ? rotuloComanda(comanda) : 'Balcão'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
          Mude quantidade ou preço, tire o que voltou ou ponha o que faltou. Estoque e caixa se acertam sozinhos pela diferença.
        </div>

        {/* Itens */}
        <div style={{ marginTop: 14 }}>
          {itens.map(i => (
            <div key={i.chave} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, wordBreak: 'break-word' }}>
                  {i.nome}
                  {!i.id && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, color: 'var(--primary)' }}>NOVO</span>}
                </div>
                <button type="button" onClick={() => tirar(i.chave)} title="Tirar da conta"
                  style={{ ...btnPeq, color: 'var(--danger, #ef4444)', borderColor: 'transparent' }}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button type="button" style={btnPeq} onClick={() => somar(i.chave, -1)}>−</button>
                <input value={i.quantidade} inputMode="decimal"
                  onChange={e => mexer(i.chave, 'quantidade', e.target.value.replace(/[^0-9,.]/g, '').slice(0, 7))}
                  style={{ ...inp, width: 56, textAlign: 'center' }} />
                <button type="button" style={btnPeq} onClick={() => somar(i.chave, 1)}>+</button>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 4 }}>× R$</span>
                <input value={i.preco} inputMode="decimal"
                  onChange={e => mexer(i.chave, 'preco', e.target.value.replace(/[^0-9,.]/g, '').slice(0, 9))}
                  style={{ ...inp, width: 80, textAlign: 'right' }} />
                <strong style={{ marginLeft: 'auto', fontSize: 13.5 }}>{fmt(num(i.preco) * num(i.quantidade))}</strong>
              </div>
            </div>
          ))}
          {itens.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>
              Nenhum item. Pra desfazer a conta inteira, feche esta janela e use "Cancelar a conta".
            </div>
          )}
        </div>

        {/* Pôr item */}
        <div style={{ marginTop: 12 }}>
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder={catalogo === null ? 'Carregando produtos…' : '➕ Pôr produto: digite o nome'}
            style={{ ...inp, width: '100%' }} />
          {achados.map(p => (
            <button key={p.produto_id} type="button" onClick={() => porDoCatalogo(p)}
              style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 4px',
                background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 13.5 }}>
              <span>{p.nome}</span><strong>{fmt(p.preco_venda)}</strong>
            </button>
          ))}
          {busca.trim() && catalogo && achados.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '6px 2px' }}>Nenhum produto com esse nome.</div>
          )}
          {avulso ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input autoFocus value={avulso.nome} placeholder="Nome do item"
                onChange={e => setAvulso(a => ({ ...a, nome: e.target.value }))}
                style={{ ...inp, flex: 1, minWidth: 0 }} />
              <input value={avulso.preco} placeholder="Preço" inputMode="decimal"
                onChange={e => setAvulso(a => ({ ...a, preco: e.target.value.replace(/[^0-9,.]/g, '').slice(0, 9) }))}
                style={{ ...inp, width: 80, textAlign: 'right' }} />
              <button type="button" onClick={porAvulso}
                style={{ ...inp, cursor: 'pointer', fontWeight: 700, color: 'var(--primary)' }}>Pôr</button>
            </div>
          ) : (
            <button type="button" onClick={() => setAvulso({ nome: '', preco: '' })}
              style={{ marginTop: 6, background: 'transparent', border: 'none', color: 'var(--primary)',
                fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: '4px 0' }}>
              + Item fora do cardápio
            </button>
          )}
        </div>

        {/* Conta nova */}
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-hover)', fontSize: 13.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
            <span>Era</span><span>{fmt(comanda.total)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
            <span>Subtotal novo</span><span>{fmt(conta.sub)}</span>
          </div>
          {conta.taxa > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
              <span>Taxa de serviço</span><span>{fmt(conta.taxa)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 15, marginTop: 4 }}>
            <span>Fica</span><span>{fmt(conta.total)}</span>
          </div>
          {Math.abs(conta.dif) >= 0.005 && (
            <div style={{ marginTop: 6, fontWeight: 800, color: conta.dif > 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
              {ehFiado
                ? (conta.dif > 0 ? `A dívida do cliente sobe ${fmt(conta.dif)}` : `A dívida do cliente desce ${fmt(-conta.dif)}`)
                : (conta.dif > 0 ? `Cliente paga mais ${fmt(conta.dif)}` : `Loja devolve ${fmt(-conta.dif)} ao cliente`)}
            </div>
          )}
        </div>

        {/* Forma da diferença */}
        {!ehFiado && Math.abs(conta.dif) >= 0.005 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
              {conta.dif > 0 ? 'A diferença foi paga em:' : 'O dinheiro foi devolvido em:'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[...FORMAS_DIF, ...valesAtivos(empresa).map(v => [v.value, v.label])].map(([id, lbl]) => (
                <button key={id} type="button" onClick={() => { setForma(id); setErro(null) }}
                  style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                    border: `1.5px solid ${forma === id ? 'var(--primary)' : 'var(--border)'}`,
                    background: forma === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.35 }}>
              Entra no caixa de HOJE. O que foi recebido no dia da conta continua lá.
            </div>
          </div>
        )}

        <input value={motivo} onChange={e => setMotivo(e.target.value.slice(0, 140))}
          placeholder="Motivo (ex.: lançou errado, produto estragado)"
          style={{ ...inp, width: '100%', marginTop: 12 }} />

        {erro && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 13, marginTop: 10 }}>{erro}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onFechar} className="btn btn-secondary" style={{ flex: '0 0 auto' }}>Voltar</button>
          <button type="button" onClick={salvar} disabled={salvando || !mudou} className="btn btn-primary" style={{ flex: 1 }}>
            {salvando ? 'Salvando…' : mudou ? 'Salvar a conta' : 'Nada mudou'}
          </button>
        </div>
      </div>
    </div>
  )
}
