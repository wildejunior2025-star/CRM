import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { feriadosNacionais, comoFicaNoDia } from '../lib/feriados'

// Feriados e datas especiais (mig 0142). Fica embaixo da grade semanal, em
// "Horários de Funcionamento", porque é a mesma pergunta: quando a loja abre.
//
// Existem os dois tipos de loja, então tem dois níveis:
//   • o interruptor de cima define o padrão da casa (fecha em feriado ou não)
//   • cada feriado pode ser mudado na mão — é como a loja que fecha em feriado
//     abre num Natal, ou a que abre sempre tira folga na Sexta-feira Santa
// Tudo salva na hora: mudar o dia da loja é decisão de uma tecla, não de formulário.

const hojeYMD = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const brData = (ymd) => {
  const [y, m, d] = ymd.split('-')
  return `${d}/${m}/${y}`
}
const DIA_SEMANA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const diaSemanaDe = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return DIA_SEMANA_CURTO[new Date(y, m - 1, d).getDay()]
}

export default function FeriadosLoja({ empresaId, grade }) {
  const [fechaFeriado, setFechaFeriado] = useState(false)
  const [excecoes, setExcecoes] = useState({})   // { 'YYYY-MM-DD': { data, aberto, motivo } }
  const [ano, setAno] = useState(() => new Date().getFullYear())
  const [carregando, setCarregando] = useState(true)
  const [salvandoData, setSalvandoData] = useState(null) // data em gravação (trava o botão)
  const [erro, setErro] = useState(null)
  // form "outra data"
  const [novaData, setNovaData] = useState('')
  const [novoMotivo, setNovoMotivo] = useState('')

  useEffect(() => {
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      const [emp, exc] = await Promise.all([
        supabase.from('empresas').select('feriados_fecha').eq('id', empresaId).maybeSingle(),
        supabase.from('dias_excecao').select('data, aberto, periodos, motivo').eq('empresa_id', empresaId).order('data'),
      ])
      if (!vivo) return
      setFechaFeriado(!!emp.data?.feriados_fecha)
      setExcecoes(Object.fromEntries((exc.data ?? []).map(r => [r.data, r])))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [empresaId])

  const feriados = useMemo(() => feriadosNacionais(ano), [ano])
  const hoje = hojeYMD()

  // Datas cadastradas na mão (as que não são feriado nacional de nenhum ano listado).
  const nomesFeriado = useMemo(() => new Set(feriados.map(f => f.data)), [feriados])
  const datasProprias = useMemo(
    () => Object.values(excecoes).filter(e => !nomesFeriado.has(e.data)).sort((a, b) => a.data.localeCompare(b.data)),
    [excecoes, nomesFeriado],
  )

  // Como o dia fica hoje, e como ficaria se ninguém tivesse marcado nada.
  const estadoDe = (data) => comoFicaNoDia(data, { grade, excecoes, fechaFeriado }).aberto
  const estadoPadraoDe = (data) => comoFicaNoDia(data, { grade, excecoes: {}, fechaFeriado }).aberto

  async function trocarPadrao(valor) {
    setFechaFeriado(valor)  // otimista: o interruptor responde na hora
    const { error } = await supabase.from('empresas').update({ feriados_fecha: valor }).eq('id', empresaId)
    if (error) { setFechaFeriado(!valor); setErro('Não deu pra salvar: ' + error.message) }
  }

  // Marca a data como aberta/fechada. Se a escolha for igual ao que já aconteceria
  // sozinho, apaga a marcação em vez de guardar — lista limpa, sem linha inútil.
  async function definirDia(data, aberto, motivo) {
    setSalvandoData(data); setErro(null)
    const ehPadrao = estadoPadraoDe(data) === aberto && !motivo
    if (ehPadrao) {
      const { error } = await supabase.from('dias_excecao').delete().eq('empresa_id', empresaId).eq('data', data)
      setSalvandoData(null)
      if (error) { setErro('Não deu pra salvar: ' + error.message); return }
      setExcecoes(prev => { const n = { ...prev }; delete n[data]; return n })
      return
    }
    const linha = { empresa_id: empresaId, data, aberto, motivo: motivo || excecoes[data]?.motivo || null }
    const { data: salvo, error } = await supabase.from('dias_excecao')
      .upsert(linha, { onConflict: 'empresa_id,data' })
      .select('data, aberto, periodos, motivo').single()
    setSalvandoData(null)
    if (error) { setErro('Não deu pra salvar: ' + error.message); return }
    setExcecoes(prev => ({ ...prev, [data]: salvo }))
  }

  async function removerData(data) {
    setSalvandoData(data)
    const { error } = await supabase.from('dias_excecao').delete().eq('empresa_id', empresaId).eq('data', data)
    setSalvandoData(null)
    if (error) { setErro('Não deu pra salvar: ' + error.message); return }
    setExcecoes(prev => { const n = { ...prev }; delete n[data]; return n })
  }

  async function adicionarData() {
    if (!novaData) { window.alert('Escolha a data.'); return }
    await definirDia(novaData, false, novoMotivo.trim() || 'Fechado')
    setNovaData(''); setNovoMotivo('')
  }

  if (carregando) {
    return <div className="card" style={{ marginTop: 16 }}><p style={{ margin: 0, color: 'var(--text-muted)' }}>Carregando feriados...</p></div>
  }

  const Chip = ({ data, aberto }) => (
    <div style={{ display: 'flex', gap: 6 }}>
      {[[true, 'Abre'], [false, 'Fecha']].map(([val, label]) => (
        <button key={label} type="button" disabled={salvandoData === data}
          onClick={() => definirDia(data, val)}
          style={{
            padding: '5px 12px', borderRadius: 999, cursor: salvandoData === data ? 'wait' : 'pointer',
            fontSize: 12.5, fontWeight: 800,
            border: `1.5px solid ${aberto === val ? (val ? 'var(--success)' : 'var(--danger)') : 'var(--border)'}`,
            background: aberto === val ? (val ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.10)') : 'transparent',
            color: aberto === val ? (val ? 'var(--success)' : 'var(--danger)') : 'var(--text-muted)',
          }}>
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>📅 Feriados e datas especiais</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
        O que vale <strong>numa data específica</strong>, por cima da grade da semana. Serve pra fechar num
        feriado, abrir num feriado que a loja normalmente fecharia, ou marcar uma folga.
        Vale na Loja Online e na conta de <strong>dias abertos no mês</strong> (Despesas &amp; Lucro).
      </p>

      {/* Padrão da casa */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Nos feriados a loja fecha</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {fechaFeriado
              ? 'Todos os feriados nacionais já entram como fechado. Dá pra abrir um por um na lista.'
              : 'A loja abre em feriado igual a qualquer outro dia. Dá pra fechar um por um na lista.'}
          </div>
        </div>
        <button type="button" className={`re-switch ${fechaFeriado ? 'on' : 'off'}`}
          onClick={() => trocarPadrao(!fechaFeriado)} aria-label="Fecha em feriado">
          <span className="re-switch-thumb" />
        </button>
      </div>

      {/* Feriados do ano */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Feriados de {ano}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAno(a => a - 1)} style={{ padding: '3px 10px' }}>‹</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAno(a => a + 1)} style={{ padding: '3px 10px' }}>›</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {feriados.map(f => {
          const aberto = estadoDe(f.data)
          const marcado = !!excecoes[f.data]
          const passou = f.data < hoje
          return (
            <div key={f.data} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 9,
              opacity: passou ? 0.55 : 1 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f.nome}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {brData(f.data)} · {diaSemanaDe(f.data)}
                  {f.facultativo && ' · ponto facultativo'}
                  {marcado && <span style={{ color: 'var(--primary)', fontWeight: 700 }}> · marcado na mão</span>}
                </div>
              </div>
              <Chip data={f.data} aberto={aberto} />
            </div>
          )
        })}
      </div>

      {/* Datas próprias (feriado da cidade, folga, festa) */}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Outras datas</div>
        {datasProprias.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            Nenhuma ainda. Use pra feriado da cidade, folga ou dia de festa.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {datasProprias.map(e => (
              <div key={e.data} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10, padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 9, opacity: e.data < hoje ? 0.55 : 1 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{e.motivo || (e.aberto ? 'Aberto' : 'Fechado')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{brData(e.data)} · {diaSemanaDe(e.data)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Chip data={e.data} aberto={estadoDe(e.data)} />
                  <button type="button" className="btn btn-secondary btn-sm" title="Tirar da lista"
                    disabled={salvandoData === e.data} onClick={() => removerData(e.data)} style={{ padding: '4px 9px' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={novaData} onChange={e => setNovaData(e.target.value)} style={{ width: 165 }} />
          <input type="text" value={novoMotivo} onChange={e => setNovoMotivo(e.target.value)}
            placeholder="Motivo (ex: festa da cidade)" style={{ flex: '1 1 190px', minWidth: 150 }} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={adicionarData}
            disabled={!novaData || salvandoData === novaData} style={{ padding: '6px 14px' }}>
            + Adicionar
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
          Entra como <strong>fechado</strong>. Se for pra abrir num dia que a loja normalmente fecha,
          adicione e depois clique em <strong>Abre</strong>.
        </p>
      </div>

      {erro && <div className="re-msg error" style={{ marginTop: 12 }}>{erro}</div>}
    </div>
  )
}
