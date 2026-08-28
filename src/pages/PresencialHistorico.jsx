import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import ClientePicker from '../components/ClientePicker'
import { rotuloComanda } from '../lib/comanda'
import { imprimirHtml, montarContaPresencialHtml } from '../utils/imprimirCupom'
import '../components/Page.css'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const FORMA_LABEL = { dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Crédito', debito: 'Débito', cartao: 'Cartão', fiado: 'Fiado', dividido: 'Dividido', transferencia: 'Transferência' }
// Formas que dá pra escolher ao corrigir uma conta (o "dividido" não entra aqui).
const FORMAS_EDIT = [['dinheiro', 'Dinheiro'], ['pix', 'PIX'], ['credito', 'Crédito'], ['debito', 'Débito'], ['cartao', 'Cartão'], ['fiado', 'Fiado']]

function horaBR(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function PresencialHistorico() {
  const { profile, user, empresa } = useAuth()
  const empresaId = profile?.empresa_id
  // A MESMA tela serve o dono e o garçom. Pro garçom ela vira "Minhas mesas":
  // só as contas que ele atendeu, sem os controles de dono (corrigir forma de
  // pagamento, ligar cliente, mexer na comissão) e sem o ranking dos colegas —
  // quanto o outro vendeu não é assunto dele.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const meuId = user?.id

  const [comandas, setComandas] = useState([])
  const [garcons, setGarcons]   = useState({})  // { profile_id: nome }
  const [entregas, setEntregas] = useState([])  // itens entregues hoje
  const [lancados, setLancados] = useState([])  // itens lançados hoje (mig 0187)
  const [fechadas, setFechadas] = useState([])  // contas fechadas hoje, por quem fechou
  const [pontosCfg, setPontosCfg] = useState({ lancar: 1, entregar: 1, fechar: 2 })
  const [rateioPct, setRateioPct] = useState(0)   // % da taxa que vira o bolo (mig 0188)
  const [taxaDoDia, setTaxaDoDia] = useState(0)   // taxa de serviço arrecadada hoje na LOJA
  const [loading, setLoading]   = useState(true)
  const [aberta, setAberta]     = useState(null) // id da comanda expandida
  const [pickerComanda, setPickerComanda] = useState(null) // comanda em que se está ligando o cliente
  const [editandoForma, setEditandoForma] = useState(null) // id da comanda com o seletor de forma aberto
  const [salvandoForma, setSalvandoForma] = useState(false)

  // ── Segunda via de uma conta já fechada ──────────────────────────────────
  //
  // A conta sai UMA vez, no fechamento. Se a térmica tinha caído do Bluetooth
  // naquele instante, o papel não saía — e a mesa já estava liberada, fora do
  // Salão. Não havia segunda via em lugar nenhum: o jeito era refazer a conta
  // na mão. Aconteceu na Saidera em 27/08/2026.
  //
  // Aqui vale pra qualquer conta de qualquer dia da lista, porque o histórico
  // já traz os itens (comanda_itens) junto.
  const [imprimindo, setImprimindo] = useState(null) // id da comanda saindo
  const [impMsg, setImpMsg] = useState(null)         // { id, texto }

  async function imprimirSegundaVia(c) {
    setImprimindo(c.id)
    setImpMsg(null)
    const nomeLoja = empresa?.nome || ''
    const dados = {
      numeroMesa: c.numero_mesa,
      // Comanda de balcão sai como "COMANDA 07 · MARIA" no lugar de "MESA 7".
      rotulo: c.tipo === 'balcao' ? rotuloComanda(c) : null,
      itens: c.comanda_itens ?? [],
      subtotal: Number(c.subtotal || 0),
      taxa: Number(c.taxa_servico || 0),
      total: Number(c.total || 0),
      // A forma vem da comanda: é a que foi realmente cobrada (e pode ter sido
      // corrigida aqui mesmo, no "Trocar").
      formaPagamento: FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '',
      pagamentos: [],
      empresa: { nome: nomeLoja },
    }
    // Térmica pareada neste aparelho primeiro (é o caso do celular do balcão);
    // senão cai no app FWC / navegador. `soApp: false` de propósito: se o app
    // não responder, é melhor abrir a janela de impressão do que não sair nada.
    let ok = false
    try {
      const mod = await import('../utils/imprimirBluetooth')
      ok = await mod.imprimirMesaSeConectada('conta', dados)
    } catch { /* sem Bluetooth neste aparelho */ }
    if (!ok) ok = await imprimirHtml(montarContaPresencialHtml(dados), nomeLoja, { soApp: false, origem: 'mesa' })
    setImprimindo(null)
    setImpMsg({ id: c.id, texto: ok ? '🧾 Segunda via enviada pra impressora.' : '⚠️ Não achei impressora neste aparelho.' })
    setTimeout(() => setImpMsg(null), 6000)
  }

  // Corrige a forma de pagamento de uma conta já fechada (lançou errado e fechou).
  async function trocarForma(comanda, forma) {
    if (forma === comanda.forma_pagamento) { setEditandoForma(null); return }
    setSalvandoForma(true)
    const { error } = await supabase.rpc('alterar_forma_pagamento_comanda', {
      p_comanda_id: comanda.id, p_forma: forma,
    })
    setSalvandoForma(false)
    setEditandoForma(null)
    if (error) { window.alert('Não deu pra trocar a forma: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id ? { ...c, forma_pagamento: forma } : c))
  }

  // Liga (ou tira) um cliente a uma conta já fechada. Propaga pra venda no banco.
  async function ligarCliente(comanda, cliente) {
    const { error } = await supabase.rpc('vincular_cliente_comanda', {
      p_comanda_id: comanda.id, p_cliente_id: cliente?.id ?? null,
    })
    setPickerComanda(null)
    if (error) { window.alert('Erro ao ligar o cliente: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id
      ? { ...c, cliente: cliente ? { id: cliente.id, nome: cliente.nome, telefone: cliente.telefone } : null }
      : c))
  }

  useEffect(() => {
    if (!empresaId) return
    const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0)
    // Antes eu filtrava no banco por `garcom_id` (quem ABRIU a mesa) e achei que
    // estava economizando dados. Estava, e estava errado: o ranking conta gesto
    // por gesto, então o garçom que entregou dez itens numa mesa que outro abriu
    // não via essa mesa em lugar nenhum — e a comissão dela sumia da vista dele.
    // Agora vem tudo e a tela separa o que é dele (participouDaConta).
    const qComandas = supabase.from('comandas')
      .select('*, comanda_itens(*), cliente:clientes(id, nome, telefone)')
      .eq('empresa_id', empresaId)
      .eq('status', 'fechada')

    Promise.all([
      qComandas.order('fechada_at', { ascending: false }).limit(100),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      supabase.from('comanda_itens')
        .select('entregue_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .eq('status', 'entregue')
        .not('entregue_por', 'is', null)
        .gte('entregue_at', inicioHoje.toISOString()),
      supabase.from('empresas').select('rateio_taxa_pct, pontos_garcom').eq('id', empresaId).single(),
      // Quem LANÇOU cada item hoje (mig 0187)
      supabase.from('comanda_itens')
        .select('lancado_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .not('lancado_por', 'is', null)
        .gte('created_at', inicioHoje.toISOString()),
      // Quem FECHOU cada conta hoje (mig 0187)
      supabase.from('comandas')
        .select('fechada_por')
        .eq('empresa_id', empresaId)
        .not('fechada_por', 'is', null)
        .gte('fechada_por_em', inicioHoje.toISOString()),
      // Taxa arrecadada hoje na LOJA INTEIRA — é ela que forma o bolo. Consulta
      // à parte de propósito: a lista de contas é limitada a 100 e filtrada por
      // garçom, então somar a taxa a partir dela daria um bolo menor que o real.
      supabase.from('comandas')
        .select('taxa_servico')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechada')
        .gte('fechada_at', inicioHoje.toISOString()),
    ]).then(([cs, gs, es, emp, ls, fs, tx]) => {
      const todas = cs.data ?? []
      // Conta em que ELE encostou: abriu, lançou, entregou ou fechou.
      const participouDaConta = (c) => c.garcom_id === meuId
        || c.fechada_por === meuId
        || (c.comanda_itens ?? []).some(i => i.entregue_por === meuId || i.lancado_por === meuId)
      setComandas(ehAdmin ? todas : todas.filter(participouDaConta))
      setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
      setEntregas(es.data ?? [])
      setLancados(ls.data ?? [])
      setFechadas(fs.data ?? [])
      setRateioPct(Number(emp.data?.rateio_taxa_pct ?? 0))
      setTaxaDoDia((tx.data ?? []).reduce((acc, c) => acc + Number(c.taxa_servico || 0), 0))
      const pc = emp.data?.pontos_garcom
      if (pc) setPontosCfg({ lancar: Number(pc.lancar ?? 1), entregar: Number(pc.entregar ?? 1), fechar: Number(pc.fechar ?? 2) })
      setLoading(false)
    })
  }, [empresaId, ehAdmin, meuId])

  async function salvarPontos(campo, valor) {
    const n = Math.max(0, Math.min(99, Number(valor) || 0))
    const novo = { ...pontosCfg, [campo]: n }
    setPontosCfg(novo)
    await supabase.from('empresas').update({ pontos_garcom: novo }).eq('id', empresaId)
  }

  async function salvarRateio(v) {
    const n = Math.max(0, Math.min(100, Number(v) || 0))
    setRateioPct(n)
    await supabase.from('empresas').update({ rateio_taxa_pct: n }).eq('id', empresaId)
  }

  // Ranking do dia por PONTOS (mig 0187).
  //
  // Antes contava só entrega. O ranking por "dono da mesa" (quem abriu) foi
  // descartado de propósito: ele obriga o garçom a carregar aquela mesa até o
  // fim pra levar o crédito, e cria o "não mexe na minha mesa" que trava o
  // salão. Contando gesto por gesto, qualquer um atende qualquer mesa.
  const rankingTodos = useMemo(() => {
    const map = {}
    const linha = (k) => (map[k] ??= { id: k, lancou: 0, entregou: 0, fechou: 0, valor: 0 })
    for (const it of lancados) linha(it.lancado_por).lancou += it.quantidade
    for (const it of entregas) {
      const l = linha(it.entregue_por)
      l.entregou += it.quantidade
      l.valor += Number(it.preco_unitario) * it.quantidade   // base da comissão em R$
    }
    for (const c of fechadas) linha(c.fechada_por).fechou += 1
    return Object.values(map).map(r => ({
      ...r,
      pontos: r.lancou * pontosCfg.lancar + r.entregou * pontosCfg.entregar + r.fechou * pontosCfg.fechar,
    })).sort((a, b) => b.pontos - a.pontos)
  }, [lancados, entregas, fechadas, pontosCfg])

  // O bolo do dia e quanto vale cada ponto. O total de pontos é o de TODOS os
  // garçons, inclusive quando a tela mostra só um: o ponto do garçom vale menos
  // no dia em que a equipe inteira trabalhou mais, e é isso que segura o bolo.
  const bolo = taxaDoDia * (Number(rateioPct) || 0) / 100
  const pontosDaLoja = rankingTodos.reduce((s, r) => s + r.pontos, 0)
  const valorPorPonto = pontosDaLoja > 0 ? bolo / pontosDaLoja : 0
  const ganhoDe = (r) => r.pontos * valorPorPonto

  const ranking = useMemo(
    () => (ehAdmin ? rankingTodos : rankingTodos.filter(r => r.id === meuId)),
    [rankingTodos, ehAdmin, meuId])

  // Resumo de hoje
  const resumoHoje = useMemo(() => {
    const hoje = new Date().toDateString()
    const doDia = comandas.filter(c => c.fechada_at && new Date(c.fechada_at).toDateString() === hoje)
    return {
      qtd: doDia.length,
      total: doDia.reduce((s, c) => s + Number(c.total || 0), 0),
    }
  }, [comandas])

  // Pontos que ELE fez nesta mesa. Não dá pra mostrar R$ por mesa: o bolo é
  // do DIA e o valor do ponto só existe depois que o dia fecha — quanto mais a
  // equipe trabalhar, menos vale o ponto. Mostrar um R$ por mesa seria um
  // número que muda sozinho até o fim do expediente.
  const pontosNaConta = (c) => {
    const itens = c.comanda_itens ?? []
    const meu = (id) => ehAdmin || id === meuId
    let p = 0
    for (const i of itens) {
      if (i.lancado_por && meu(i.lancado_por)) p += i.quantidade * pontosCfg.lancar
      if (i.entregue_por && meu(i.entregue_por)) p += i.quantidade * pontosCfg.entregar
    }
    if (c.fechada_por && meu(c.fechada_por)) p += pontosCfg.fechar
    return p
  }

  // O que ele leva hoje: os pontos dele vezes o valor do ponto.
  const meuGanhoHoje = rankingTodos
    .filter(r => r.id === meuId)
    .reduce((s, r) => s + ganhoDe(r), 0)

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to={ehAdmin ? '/pedidos-delivery' : '/presencial/salao'} style={{ color: 'var(--primary)' }}>
              {ehAdmin ? '← Vendas' : '← Salão'}
            </Link>
          </p>
          <h1>{ehAdmin ? 'Vendas salão' : 'Minhas mesas'}</h1>
          <p className="page-subtitle">
            {ehAdmin ? 'Contas fechadas do salão.' : 'As mesas que você atendeu e já foram fechadas.'}
          </p>
        </div>
      </div>

      {/* Resumo de hoje — dois blocos de largura igual, pra caber lado a lado
          na tela do celular em vez de um empurrar o outro pra baixo. */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.3 }}>
            {ehAdmin ? 'Contas fechadas hoje' : 'Mesas fechadas hoje'}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}>{resumoHoje.qtd}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          {/* Pro dono, o que entrou. Pro garçom, o que É DELE — mostrar o total
              das mesas pra ele daria a impressão errada de que aquele dinheiro
              é o ganho dele. */}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.3 }}>
            {ehAdmin ? 'Recebido hoje (com a taxa)' : 'Você ganhou hoje'}
          </div>
          <div style={{ fontSize: 21, fontWeight: 800, marginTop: 2, color: 'var(--success)', overflowWrap: 'anywhere' }}>
            {fmt(ehAdmin ? resumoHoje.total : meuGanhoHoje)}
          </div>
        </div>
      </div>

      {/* A taxa de serviço tinha um lugar só: escondida dentro da frase do bolo,
          e só quando o rateio estava ligado. É o número que o dono precisa pra
          saber quanto entrou de taxa e quanto dela sai da mão dele. */}
      {ehAdmin && taxaDoDia > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Taxa de serviço arrecadada hoje</span>
            <strong style={{ fontSize: 22 }}>{fmt(taxaDoDia)}</strong>
          </div>
          {Number(rateioPct) > 0 ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Vai pros garçons ({rateioPct}%)</span>
                <strong style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(bolo)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Fica com a loja</span>
                <strong style={{ whiteSpace: 'nowrap' }}>{fmt(taxaDoDia - bolo)}</strong>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Tudo fica com a loja. Pra repassar uma parte pros garçons, defina a fatia
              logo abaixo, em <strong>Quanto vale cada gesto</strong>.
            </div>
          )}
        </div>
      )}

      {/* Pontos do dia (mig 0187).
          Era uma tabela de 5 colunas — no celular virava um amontoado de números
          espremidos. Agora o garçom vê um cartão com o número dele grande e três
          blocos, e o dono vê uma lista de linhas, sem tabela. */}
      {ranking.length > 0 && (() => {
        const temBolo = bolo > 0 && pontosDaLoja > 0

        const bloco = (n, lbl, icone) => (
          <div key={lbl} style={{
            flex: 1, minWidth: 0, textAlign: 'center', padding: '10px 4px',
            borderRadius: 10, background: 'var(--surface-hover)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.1 }}>{n}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{icone} {lbl}</div>
          </div>
        )

        return (
          <div style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* ── Garçom: o número dele, grande ── */}
            {!ehAdmin && ranking.map(r => (
              <div key={r.id} className="card" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Seus pontos hoje</div>
                <div style={{ fontSize: 46, fontWeight: 900, lineHeight: 1.05, color: 'var(--primary)' }}>{r.pontos}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {bloco(r.lancou, 'lançou', '✍️')}
                  {bloco(r.entregou, 'entregou', '🍽️')}
                  {bloco(r.fechou, 'fechou', '🧾')}
                </div>
                {temBolo && (
                  <div style={{
                    marginTop: 12, padding: '10px 12px', borderRadius: 10, display: 'flex',
                    alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    background: 'rgba(16,185,129,.10)', border: '1px solid rgba(16,185,129,.35)',
                  }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'left' }}>
                      {r.pontos} pontos × {fmt(valorPorPonto)} por ponto
                    </span>
                    <strong style={{ fontSize: 19, color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(ganhoDe(r))}</strong>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  Lançar item vale {pontosCfg.lancar}, entregar vale {pontosCfg.entregar} e fechar conta
                  vale {pontosCfg.fechar}.
                  {temBolo && (
                    <> A loja separa {rateioPct}% da taxa de serviço do dia ({fmt(bolo)} até agora) e divide
                    entre todos pelos pontos. Hoje a equipe fez {pontosDaLoja} pontos, então cada ponto
                    está valendo {fmt(valorPorPonto)} — esse valor muda até o fim do expediente.</>
                  )}
                </div>
              </div>
            ))}

            {/* ── Dono: lista, uma linha por garçom ── */}
            {ehAdmin && (
              <div className="card">
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>🏆 Pontos por garçom (hoje)</div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.45 }}>
                  Conta gesto por gesto, não mesa por mesa — assim qualquer um atende qualquer mesa
                  sem perder o crédito do que fez.
                </p>

                {ranking.map((r, i) => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 17, width: 26, textAlign: 'center', flexShrink: 0 }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {garcons[r.id] ?? 'Garçom'}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                        ✍️ {r.lancou} · 🍽️ {r.entregou} · 🧾 {r.fechou}
                        {temBolo && (
                          <> · <span style={{ color: 'var(--success)', fontWeight: 700 }}>{fmt(ganhoDe(r))}</span></>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{r.pontos}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>pontos</div>
                    </div>
                  </div>
                ))}

                {temBolo ? (
                  <div style={{ paddingTop: 10, marginTop: 4, borderTop: '1px dashed var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 800, fontSize: 13.5 }}>
                      <span>Bolo do dia ({rateioPct}% de {fmt(taxaDoDia)} de taxa)</span>
                      <span style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(bolo)}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                      {pontosDaLoja} pontos no total · cada ponto vale {fmt(valorPorPonto)}
                    </div>
                  </div>
                ) : Number(rateioPct) > 0 && (
                  <div style={{ paddingTop: 10, marginTop: 4, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                    Ainda não há taxa arrecadada hoje — o bolo aparece quando a primeira conta fechar.
                  </div>
                )}
              </div>
            )}

            {/* ── Dono: quanto vale cada gesto ── */}
            {ehAdmin && (
              <div className="card">
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Quanto vale cada gesto</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[['lancar', '✍️ Lançar item'], ['entregar', '🍽️ Entregar item'], ['fechar', '🧾 Fechar conta']].map(([k, lbl]) => (
                    <label key={k} style={{
                      flex: '1 1 140px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, padding: '9px 11px', borderRadius: 10,
                      background: 'var(--surface-hover)', border: '1px solid var(--border)',
                      fontSize: 12.5, color: 'var(--text-muted)',
                    }}>
                      <span style={{ whiteSpace: 'nowrap' }}>{lbl}</span>
                      <input type="number" min="0" max="99" step="1" value={pontosCfg[k]}
                        onChange={e => setPontosCfg(p => ({ ...p, [k]: e.target.value }))}
                        onBlur={e => salvarPontos(k, e.target.value)}
                        style={{ width: 48, padding: '5px 6px', borderRadius: 7, textAlign: 'center', fontWeight: 800,
                          border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                    </label>
                  ))}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, fontSize: 12.5, color: 'var(--text-muted)' }}>
                  Quanto da <strong style={{ color: 'var(--text)' }}>taxa de serviço</strong> vai pros garçons (0 = não usa)
                  <input type="number" min="0" max="100" step="1" value={rateioPct}
                    onChange={e => setRateioPct(e.target.value)} onBlur={e => salvarRateio(e.target.value)}
                    style={{ width: 64, padding: '5px 8px', borderRadius: 8, textAlign: 'center', fontWeight: 800, flexShrink: 0,
                      border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                </label>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                  É uma fatia do que a loja JÁ arrecadou de taxa — o bolo nunca estoura. Se a equipe
                  trabalhar mais, o ponto vale menos e a loja paga o mesmo; em dia fraco, paga menos.
                  {Number(rateioPct) > 0 && (
                    <> Hoje a loja arrecadou {fmt(taxaDoDia)} de taxa, então {rateioPct}% dá
                    <strong style={{ color: 'var(--success)' }}> {fmt(bolo)}</strong> pra dividir.</>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {comandas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          {ehAdmin ? 'Nenhuma conta fechada ainda. Feche uma conta no Salão que ela aparece aqui. 🧾' : 'Você ainda não teve mesa fechada. Assim que fechar, ela aparece aqui. 🧾'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comandas.map(c => {
            const expandida = aberta === c.id
            return (
              <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <button type="button" onClick={() => setAberta(expandida ? null : c.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {c.numero_mesa ? rotuloComanda(c) : 'Balcão'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {horaBR(c.fechada_at)} · {FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}
                      {' · '}{(c.comanda_itens ?? []).length} {(c.comanda_itens ?? []).length === 1 ? 'item' : 'itens'}
                    </div>
                    {/* Quanto ele ganhou nesta mesa. É a pergunta que o garçom
                        faz olhando o histórico — o total do dia não responde
                        "e nessa mesa aqui, quanto eu tirei?". */}
                    {pontosNaConta(c) > 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--primary)', fontWeight: 700, marginTop: 1 }}>
                        ✨ {ehAdmin ? 'pontos nesta mesa' : 'seus pontos aqui'}: {pontosNaConta(c)}
                      </div>
                    )}
                    {(c.garcom_id || c.fechada_por) && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        {c.garcom_id && garcons[c.garcom_id] && <>👤 abriu: {garcons[c.garcom_id]}</>}
                        {c.garcom_id && garcons[c.garcom_id] && c.fechada_por && garcons[c.fechada_por] && ' · '}
                        {c.fechada_por && garcons[c.fechada_por] && <>🧾 fechou: {garcons[c.fechada_por]}</>}
                      </div>
                    )}
                    {c.cliente && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
                        🧑 Cliente: {c.cliente.nome}{c.cliente.telefone ? ` · ${c.cliente.telefone}` : ''}
                      </div>
                    )}
                  </div>
                  <strong style={{ fontSize: 16 }}>{fmt(c.total)}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandida ? '▲' : '▼'}</span>
                </button>

                {expandida && (
                  <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border)' }}>
                    {(c.comanda_itens ?? []).map(it => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                        <div>
                          <div style={{ fontSize: 13.5 }}>{it.quantidade}× {it.nome}</div>
                          {it.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📝 {it.observacao}</div>}
                          {/* A trilha de quem fez o quê. Estava só no banco: quando o
                              cliente contestava um item na hora de pagar, a resposta
                              existia mas ninguém conseguia olhar. Agora está na linha
                              do próprio item — que é onde a pergunta nasce. */}
                          {(it.lancado_por || it.entregue_por) && (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                              {it.lancado_por && <>✍️ lançou: {garcons[it.lancado_por] ?? '—'}</>}
                              {it.lancado_por && it.entregue_por && ' · '}
                              {it.entregue_por && <>🍽️ entregou: {garcons[it.entregue_por] ?? '—'}</>}
                            </div>
                          )}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(it.preco_unitario * it.quantidade)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingTop: 8, color: 'var(--text-muted)' }}>
                      <span>Subtotal</span><span>{fmt(c.subtotal)}</span>
                    </div>
                    {Number(c.taxa_servico) > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                        <span>Taxa de serviço</span><span>{fmt(c.taxa_servico)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(c.total)}</span>
                    </div>

                    {/* Forma de pagamento — mostra e deixa corrigir se lançou errado */}
                    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-hover)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13.5 }}>
                          💳 Pagamento: <strong>{FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}</strong>
                        </span>
                        {ehAdmin && editandoForma !== c.id && (
                          <button type="button" onClick={() => setEditandoForma(c.id)}
                            style={{ padding: '5px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)',
                              background: 'transparent', color: 'var(--primary)', fontSize: 12.5, fontWeight: 700 }}>
                            Trocar
                          </button>
                        )}
                      </div>
                      {editandoForma === c.id && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Escolha a forma correta:</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {FORMAS_EDIT.map(([id, lbl]) => (
                              <button key={id} type="button" disabled={salvandoForma} onClick={() => trocarForma(c, id)}
                                style={{ padding: '7px 12px', borderRadius: 8, cursor: salvandoForma ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13,
                                  border: `1.5px solid ${c.forma_pagamento === id ? 'var(--primary)' : 'var(--border)'}`,
                                  background: c.forma_pagamento === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                                {lbl}
                              </button>
                            ))}
                            <button type="button" onClick={() => setEditandoForma(null)}
                              style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
                              Cancelar
                            </button>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                            Fiado precisa de um cliente ligado à conta (é dívida, não entra no caixa).
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Segunda via: NÃO é só do dono. Quem fica sem o papel é
                        quem fechou a conta — em geral o garçom, com a térmica
                        dele caindo do Bluetooth na hora errada. */}
                    <button type="button" onClick={() => imprimirSegundaVia(c)} disabled={imprimindo === c.id}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10,
                        cursor: imprimindo === c.id ? 'wait' : 'pointer',
                        border: '1px solid var(--border)', background: 'transparent',
                        color: 'var(--text)', fontSize: 13.5, fontWeight: 700 }}>
                      {imprimindo === c.id ? 'Enviando…' : '🖨️ Imprimir segunda via'}
                    </button>
                    {impMsg?.id === c.id && (
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>{impMsg.texto}</div>
                    )}

                    {/* Ligar/trocar o cliente deste pedido já fechado — mexe em fiado
                        e no cadastro, então é coisa de dono. */}
                    {ehAdmin && (
                    <button type="button" onClick={() => setPickerComanda(c)}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                        border: `1.5px ${c.cliente ? 'solid var(--border)' : 'dashed var(--primary)'}`,
                        background: c.cliente ? 'transparent' : 'rgba(124,58,237,.06)',
                        color: c.cliente ? 'var(--text)' : 'var(--primary)', fontSize: 13.5, fontWeight: 700 }}>
                      {c.cliente ? `🧑 ${c.cliente.nome} · trocar cliente` : '➕ Ligar cliente a este pedido'}
                    </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pickerComanda && (
        <ClientePicker
          empresaId={empresaId}
          titulo={pickerComanda.numero_mesa ? `Cliente da ${rotuloComanda(pickerComanda, { comNome: false })}` : 'Cliente do pedido'}
          permitirTirar={!!pickerComanda.cliente}
          onPick={(cli) => ligarCliente(pickerComanda, cli)}
          onFechar={() => setPickerComanda(null)}
        />
      )}
    </div>
  )
}
