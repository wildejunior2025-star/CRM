import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { semanaAtual } from '../../lib/microciclo'
import { ehHoje, diaDeHoje } from '../../lib/diaSemana'

// "Meus treinos" do aluno: o treino do dia primeiro, com o número da máquina
// de cada exercício — é por ele que o aluno acha o aparelho na academia.
//
// Série e repetição vêm do microciclo (a tabela de semanas do cartão): se o
// professor tiver montado, cada exercício mostra "3 séries de 8 a 12".

// Vídeo de execução: o professor pode prender um vídeo certo no exercício
// (botão 🎥 na área dele). Quando não prendeu — que é o caso de quase todos
// —, o aluno cai numa busca pronta no YouTube em vez de ficar sem nada.
// Link de busca não quebra com o tempo, que é o problema de guardar vídeo.
// Pede SHORTS na busca: o aluno está no celular, e short é vertical — enche
// a tela, sem aquela tarja preta em cima e embaixo do vídeo deitado.
function buscaNoYoutube(nome) {
  const busca = encodeURIComponent(`${nome} execução correta academia #shorts`)
  return `https://www.youtube.com/results?search_query=${busca}`
}

// Subiu de verdade? Só quando há duas anotações diferentes e a de agora é
// maior — repetir a mesma carga não é evolução, e não vale inventar aplauso.
function subiu(primeira, ultima) {
  return primeira?.carga != null && ultima?.carga != null
    && ultima.carga > primeira.carga && primeira.data !== ultima.data
}

export default function AlunoTreinos({ aluno }) {
  const [treinos, setTreinos] = useState(null)
  const [itens, setItens] = useState({})
  const [semana, setSemana] = useState(null)
  const [ciclo, setCiclo] = useState(null)
  const [aberto, setAberto] = useState(null)
  // Carga e "feito": é o que os apps concorrentes têm e o nosso não tinha.
  const [ultimas, setUltimas] = useState({})   // item_id → { carga, data }
  const [primeiras, setPrimeiras] = useState({}) // item_id → a carga mais antiga
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
        setAberto(trs.find(t => ehHoje(t.dia_semana))?.id || trs[0].id)
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
      // A PRIMEIRA carga também: é o que transforma "última vez: 25 kg" em
      // "você saiu de 20 pra 25". Sem a comparação o aluno não vê que evoluiu
      // — e evoluir é o motivo de ele anotar.
      const primeiras = {}
      ;(execs || []).forEach(e => {
        if (!e.item_id) return
        if (!ult[e.item_id]) ult[e.item_id] = e
        if (e.carga != null) primeiras[e.item_id] = e  // vem do mais novo pro mais velho
        if (e.data === hojeIso) hojeFeitos[e.item_id] = e.carga
      })
      setUltimas(ult)
      setPrimeiras(primeiras)
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
      // A semana "de agora" sai da data em que o ciclo começou. Antes era
      // sempre a primeira: o aluno ficava em 3x12-15 pra sempre e as outras
      // sete que o professor montou não serviam pra nada.
      const montadas = (semanas || []).filter(w => w.series || w.rep_min)
      const onde = semanaAtual(aluno.microciclo_inicio, montadas.length)
      setCiclo(onde)
      setSemana(montadas.find(w => w.numero === onde.numero) || montadas[0] || null)
    })()
  }, [aluno.id, aluno.empresa_id, aluno.microciclo_inicio])

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

  const hoje = diaDeHoje()
  const doDia = treinos.find(t => ehHoje(t.dia_semana))
  const quantosSubiram = Object.keys(primeiras).filter(id => subiu(primeiras[id], ultimas[id])).length

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

      {quantosSubiram > 0 && (
        <section className="al-evolucao">
          <strong>Você subiu a carga em {quantosSubiram} {quantosSubiram === 1 ? 'exercício' : 'exercícios'}</strong>
          <span>Desde que começou a anotar. Continue marcando o peso de cada série.</span>
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
            <>
              {ciclo?.total > 1 && (
                <p className="al-ciclo">
                  <span>Semana {ciclo.numero} de {ciclo.total}</span>
                  <span className="al-ciclo-barra">
                    <i style={{ width: `${(ciclo.numero / ciclo.total) * 100}%` }} />
                  </span>
                </p>
              )}
              <p className="al-semana">
                {semana.series ? `${semana.series} séries` : ''}
                {semana.rep_min ? ` de ${semana.rep_min}${semana.rep_max ? ` a ${semana.rep_max}` : ''} repetições` : ''}
                {semana.sistema ? ` · ${semana.sistema}` : ''}
                {semana.aumentar_peso ? ' · suba o peso esta semana' : ''}
              </p>
            </>
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
                    {videos[i.exercicio_id] ? (
                      <a className="al-video" href={videos[i.exercicio_id]} target="_blank" rel="noreferrer">
                        ▶ ver como faz
                      </a>
                    ) : (
                      <a className="al-video" href={buscaNoYoutube(i.nome)} target="_blank" rel="noreferrer">
                        ▶ ver como faz no YouTube
                      </a>
                    )}
                    {feito
                      ? <small className="al-carga-ok">feito hoje{feitosHoje[i.id] ? ` · ${feitosHoje[i.id]} kg` : ''}</small>
                      : ultima?.carga
                        ? <small className="al-carga">última vez: {ultima.carga} kg</small>
                        : null}
                    {subiu(primeiras[i.id], ultima) && (
                      <small className="al-evoluiu">
                        ↑ saiu de {primeiras[i.id].carga} pra {ultima.carga} kg
                      </small>
                    )}
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
