import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'

// "Meus treinos" do aluno: o treino do dia primeiro, com o número da máquina
// de cada exercício — é por ele que o aluno acha o aparelho na academia.
//
// Série e repetição vêm do microciclo (a tabela de semanas do cartão): se o
// professor tiver montado, cada exercício mostra "3 séries de 8 a 12".

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export default function AlunoTreinos({ aluno }) {
  const [treinos, setTreinos] = useState(null)
  const [itens, setItens] = useState({})
  const [semana, setSemana] = useState(null)
  const [aberto, setAberto] = useState(null)
  // Carga e "feito": é o que os apps concorrentes têm e o nosso não tinha.
  const [ultimas, setUltimas] = useState({})   // item_id → { carga, data }
  const [feitosHoje, setFeitosHoje] = useState({}) // item_id → carga de hoje
  const [editando, setEditando] = useState(null)   // item_id com o campo aberto
  const [carga, setCarga] = useState('')
  const [descanso, setDescanso] = useState(null)   // segundos restantes
  const [videos, setVideos] = useState({})         // exercicio_id → link
  const relogio = useRef(null)

  useEffect(() => {
    (async () => {
      const { data: trs } = await supabase
        .from('academia_treinos')
        .select('*')
        .eq('aluno_id', aluno.id)
        .eq('ativo', true)
        .order('letra')
      setTreinos(trs || [])
      if (trs?.length) {
        const { data: its } = await supabase
          .from('academia_treino_itens')
          .select('*')
          .in('treino_id', trs.map(t => t.id))
          .order('ordem')
        const porTreino = {}
        ;(its || []).forEach(i => { (porTreino[i.treino_id] ||= []).push(i) })
        setItens(porTreino)
        const hoje = DIAS[new Date().getDay()]
        setAberto(trs.find(t => t.dia_semana === hoje)?.id || trs[0].id)
      }
      // Última carga de cada exercício e o que já foi feito hoje.
      const hojeIso = new Date().toISOString().slice(0, 10)
      const { data: execs } = await supabase
        .from('academia_execucoes')
        .select('item_id, carga, data')
        .eq('aluno_id', aluno.id)
        .order('data', { ascending: false })
        .limit(400)
      const ult = {}
      const hojeFeitos = {}
      ;(execs || []).forEach(e => {
        if (!e.item_id) return
        if (!ult[e.item_id]) ult[e.item_id] = e
        if (e.data === hojeIso) hojeFeitos[e.item_id] = e.carga
      })
      setUltimas(ult)
      setFeitosHoje(hojeFeitos)

      // Vídeos de execução cadastrados pelo professor.
      const { data: exs } = await supabase
        .from('academia_exercicios')
        .select('id, video_url')
        .eq('empresa_id', aluno.empresa_id)
        .not('video_url', 'is', null)
      setVideos(Object.fromEntries((exs || []).map(e => [e.id, e.video_url])))

      const { data: semanas } = await supabase
        .from('academia_semanas')
        .select('*')
        .eq('aluno_id', aluno.id)
        .order('numero')
      // Semana "de agora": a primeira que o professor montou é a 1; sem
      // controle de data ainda, mostramos a primeira preenchida.
      setSemana((semanas || [])[0] || null)
    })()
  }, [aluno.id, aluno.empresa_id])

  // Cronômetro de descanso entre as séries.
  function comecarDescanso(segundos) {
    clearInterval(relogio.current)
    setDescanso(segundos)
    relogio.current = setInterval(() => {
      setDescanso(s => {
        if (s <= 1) { clearInterval(relogio.current); return null }
        return s - 1
      })
    }, 1000)
  }

  async function marcarFeito(item, valor) {
    const limpo = valor === '' || valor === null ? null : Number(String(valor).replace(',', '.'))
    await supabase.from('academia_execucoes').insert({
      empresa_id: aluno.empresa_id,
      aluno_id: aluno.id,
      treino_id: item.treino_id,
      item_id: item.id,
      carga: limpo,
    })
    setFeitosHoje(f => ({ ...f, [item.id]: limpo }))
    setUltimas(u => ({ ...u, [item.id]: { carga: limpo, data: new Date().toISOString().slice(0, 10) } }))
    setEditando(null)
    setCarga('')
    comecarDescanso(60)
  }

  if (treinos === null) return <p className="al-vazio">Carregando...</p>

  if (treinos.length === 0) {
    return (
      <section className="al-bloco">
        <p className="al-texto">Seu treino ainda não foi montado. Fale com o professor.</p>
      </section>
    )
  }

  const hoje = DIAS[new Date().getDay()]
  const doDia = treinos.find(t => t.dia_semana === hoje)

  return (
    <>
      {descanso !== null && (
        <div className="al-descanso" onClick={() => { clearInterval(relogio.current); setDescanso(null) }}>
          Descanso: <strong>{descanso}s</strong> <span>(toque para parar)</span>
        </div>
      )}
      {doDia ? (
        <section className="al-hoje">
          <span className="al-rotulo">Hoje é {hoje.toLowerCase()}</span>
          <strong>Treino {doDia.letra}</strong>
          <span className="al-sub">{(itens[doDia.id] || []).length} exercícios</span>
        </section>
      ) : (
        <section className="al-bloco">
          <p className="al-texto">Hoje você não tem treino marcado. Escolha um abaixo.</p>
        </section>
      )}

      <div className="al-letras">
        {treinos.map(t => (
          <button
            key={t.id}
            className={`al-letra${aberto === t.id ? ' ativa' : ''} tem`}
            onClick={() => setAberto(t.id)}
          >
            {t.letra}
            <small>{t.dia_semana || '—'}</small>
          </button>
        ))}
      </div>

      {treinos.filter(t => t.id === aberto).map(t => (
        <section key={t.id} className="al-bloco">
          <h2>Treino {t.letra}{t.dia_semana ? ` · ${t.dia_semana}` : ''}</h2>
          {semana && (
            <p className="al-semana">
              {semana.series ? `${semana.series} séries` : ''}
              {semana.rep_min ? ` de ${semana.rep_min}${semana.rep_max ? ` a ${semana.rep_max}` : ''} repetições` : ''}
              {semana.sistema ? ` · ${semana.sistema}` : ''}
            </p>
          )}
          <ul className="al-itens-aluno">
            {(itens[t.id] || []).map((i, n) => {
              const feito = i.id in feitosHoje
              const ultima = ultimas[i.id]
              return (
                <li key={i.id} className={feito ? 'feito' : ''}>
                  <button className="al-item-check" onClick={() => (feito ? null : setEditando(editando === i.id ? null : i.id))}>
                    {feito ? '✓' : n + 1}
                  </button>
                  <span className="al-item-nome">
                    <strong>{i.nome}{i.variacao ? ` (${i.variacao})` : ''}</strong>
                    <small>
                      {i.maquina ? `máquina ${i.maquina}` : 'peso livre'}
                      {i.observacao ? ` · ${i.observacao}` : ''}
                    </small>
                    {videos[i.exercicio_id] && (
                      <a className="al-video" href={videos[i.exercicio_id]} target="_blank" rel="noreferrer">
                        ▶ ver como faz
                      </a>
                    )}
                    {feito
                      ? <small className="al-carga-ok">feito hoje{feitosHoje[i.id] ? ` · ${feitosHoje[i.id]} kg` : ''}</small>
                      : ultima?.carga
                        ? <small className="al-carga">última vez: {ultima.carga} kg</small>
                        : null}
                    {editando === i.id && (
                      <span className="al-carga-campo">
                        <input
                          inputMode="decimal" autoFocus placeholder="carga (kg)"
                          value={carga} onChange={e => setCarga(e.target.value)}
                        />
                        <button onClick={() => marcarFeito(i, carga)}>Feito</button>
                      </span>
                    )}
                  </span>
                  {i.maquina && <span className="al-maquina">{i.maquina}</span>}
                </li>
              )
            })}
            {(itens[t.id] || []).length === 0 && <li className="al-vazio">Sem exercícios ainda.</li>}
          </ul>
        </section>
      ))}
    </>
  )
}
