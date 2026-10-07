import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'

// O professor monta o treino do aluno pelo celular, do mesmo jeito que fazia
// no cartão: escolhe os treinos A a E, marca o dia e vai marcando os
// exercícios de cada grupo. O número da máquina vem junto.

const LETRAS = ['A', 'B', 'C', 'D', 'E', 'F']
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const VARIACOES = ['', 'H', 'UNI', 'ABERTO', 'CROSS']

export default function ProfessorTreino({ aluno, onVoltar }) {
  const { profile } = useAuth()
  const [exercicios, setExercicios] = useState([])
  const [treinos, setTreinos] = useState([])
  const [itens, setItens] = useState({}) // treino_id → itens
  const [letra, setLetra] = useState('A')
  const [escolhendo, setEscolhendo] = useState(false)
  // Criar exercício na hora: no cartão de papel ele escrevia à mão os que não
  // estavam na lista (Sumô, Búlgaro, Afundo/Step).
  const [novo, setNovo] = useState(null) // { nome, grupo, maquina }
  // IA: ela faz o RASCUNHO; quem assina e o professor (prescricao e dele).
  const [ia, setIa] = useState(null)       // { objetivo, nivel, dias, restricoes }
  const [plano, setPlano] = useState(null) // resposta da IA, esperando o "usar"
  const [pensando, setPensando] = useState(false)
  const [semanas, setSemanas] = useState([])   // microciclo (o quadro do cartão)
  const [cargas, setCargas] = useState({})     // item_id → { carga, data } da última vez
  const [verSemanas, setVerSemanas] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    const [{ data: exs }, { data: trs }] = await Promise.all([
      supabase.from('academia_exercicios').select('*').eq('empresa_id', profile.empresa_id)
        .eq('ativo', true).order('grupo').order('ordem'),
      supabase.from('academia_treinos').select('*').eq('aluno_id', aluno.id).order('letra'),
    ])
    setExercicios(exs || [])
    setTreinos(trs || [])

    const [{ data: sem }, { data: execs }] = await Promise.all([
      supabase.from('academia_semanas').select('*').eq('aluno_id', aluno.id).order('numero'),
      supabase.from('academia_execucoes').select('item_id, carga, data')
        .eq('aluno_id', aluno.id).order('data', { ascending: false }).limit(400),
    ])
    setSemanas(sem || [])
    const ult = {}
    ;(execs || []).forEach(e => { if (e.item_id && !ult[e.item_id]) ult[e.item_id] = e })
    setCargas(ult)
    if (trs?.length) {
      const { data: its } = await supabase
        .from('academia_treino_itens').select('*')
        .in('treino_id', trs.map(t => t.id)).order('ordem')
      const porTreino = {}
      ;(its || []).forEach(i => { (porTreino[i.treino_id] ||= []).push(i) })
      setItens(porTreino)
    } else {
      setItens({})
    }
  }, [aluno.id, profile.empresa_id])

  useEffect(() => { carregar() }, [carregar])

  const treino = treinos.find(t => t.letra === letra)
  const lista = treino ? (itens[treino.id] || []) : []

  async function garantirTreino() {
    if (treino) return treino
    const { data, error } = await supabase
      .from('academia_treinos')
      .insert({ empresa_id: profile.empresa_id, aluno_id: aluno.id, letra, criado_por: profile.id })
      .select()
      .single()
    if (error) { setErro(error.message); return null }
    setTreinos(t => [...t, data])
    return data
  }

  async function adicionar(ex) {
    setSalvando(true)
    setErro(null)
    const t = await garantirTreino()
    if (!t) { setSalvando(false); return }
    const { error } = await supabase.from('academia_treino_itens').insert({
      treino_id: t.id,
      exercicio_id: ex.id,
      nome: ex.nome,
      maquina: ex.maquina,
      ordem: (itens[t.id]?.length || 0) + 1,
    })
    setSalvando(false)
    if (error) return setErro(error.message)
    carregar()
  }

  // Exercício que não existe na lista: cria no catálogo da academia e já põe
  // no treino. Da próxima vez ele aparece pra todo mundo.
  async function criarExercicio(e) {
    e.preventDefault()
    if (!novo.nome.trim()) return setErro('Dê um nome ao exercício.')
    setSalvando(true)
    setErro(null)
    const { data, error } = await supabase
      .from('academia_exercicios')
      .insert({
        empresa_id: profile.empresa_id,
        grupo: novo.grupo,
        nome: novo.nome.trim(),
        maquina: novo.maquina.trim() || null,
        ordem: 99,
      })
      .select()
      .single()
    if (error) { setSalvando(false); return setErro(error.message) }
    setExercicios(l => [...l, data])
    setNovo(null)
    await adicionar(data)
  }

  // Vídeo de execução: o professor cola o link (YouTube etc.) e o aluno abre
  // no treino. É o que os apps concorrentes mostram com foto e vídeo.
  async function mudarVideo(ex) {
    const atual = ex.video_url || ''
    const link = window.prompt(`Link do vídeo de ${ex.nome} (deixe vazio para tirar):`, atual)
    if (link === null) return
    const { error } = await supabase
      .from('academia_exercicios')
      .update({ video_url: link.trim() || null })
      .eq('id', ex.id)
    if (error) return setErro(error.message)
    setExercicios(l => l.map(x => (x.id === ex.id ? { ...x, video_url: link.trim() || null } : x)))
  }

  async function remover(item) {
    await supabase.from('academia_treino_itens').delete().eq('id', item.id)
    carregar()
  }

  async function mudarVariacao(item, variacao) {
    await supabase.from('academia_treino_itens').update({ variacao: variacao || null }).eq('id', item.id)
    carregar()
  }

  async function mudarDia(dia) {
    const t = await garantirTreino()
    if (!t) return
    await supabase.from('academia_treinos').update({ dia_semana: dia || null }).eq('id', t.id)
    carregar()
  }

  async function apagarTreino() {
    if (!treino) return
    if (!window.confirm(`Apagar o treino ${letra} de ${aluno.nome.split(' ')[0]}?`)) return
    await supabase.from('academia_treinos').delete().eq('id', treino.id)
    carregar()
  }

  async function pedirIa(e) {
    e.preventDefault()
    setPensando(true)
    setErro(null)
    const { data, error } = await supabase.functions.invoke('montar-treino', {
      body: {
        exercicios: exercicios.map(x => ({ id: x.id, nome: x.nome, grupo: x.grupo, maquina: x.maquina })),
        aluno: {
          nome: aluno.nome, objetivo: aluno.objetivo, sexo: aluno.sexo,
          diabetes: aluno.diabetes, hipertensao: aluno.hipertensao,
          cardiopata: aluno.cardiopata, saude_outra: aluno.saude_outra,
        },
        pedido: ia,
      },
    })
    setPensando(false)
    if (error || data?.erro) return setErro(data?.erro || 'A IA nao respondeu. Tente de novo.')
    setPlano(data)
    setIa(null)
  }

  // Grava o rascunho da IA: apaga os treinos de antes e poe os novos.
  async function usarPlano() {
    setSalvando(true)
    setErro(null)
    try {
      if (treinos.length) {
        await supabase.from('academia_treinos').delete().eq('aluno_id', aluno.id)
      }
      for (const t of plano.treinos) {
        const { data: criado, error } = await supabase
          .from('academia_treinos')
          .insert({
            empresa_id: profile.empresa_id, aluno_id: aluno.id,
            letra: t.letra, dia_semana: t.dia_semana || null, nome: t.foco || null,
            criado_por: profile.id,
          })
          .select().single()
        if (error) throw error
        const novos = t.itens.map((i, n) => ({
          treino_id: criado.id, exercicio_id: i.id, nome: i.nome,
          maquina: i.maquina, variacao: i.variacao || null, observacao: i.obs || null, ordem: n + 1,
        }))
        if (novos.length) {
          const { error: e2 } = await supabase.from('academia_treino_itens').insert(novos)
          if (e2) throw e2
        }
      }
      if (plano.semanas?.length) {
        await supabase.from('academia_semanas').delete().eq('aluno_id', aluno.id)
        const { error: e3 } = await supabase.from('academia_semanas').insert(
          plano.semanas.map(w => ({
            aluno_id: aluno.id, numero: w.numero, series: w.series,
            rep_min: w.rep_min, rep_max: w.rep_max, sistema: w.sistema || null,
            aumentar_peso: !!w.aumentar_peso,
          })),
        )
        if (e3) throw e3
      }
      setPlano(null)
      await carregar()
    } catch (err) {
      setErro('Nao deu pra salvar: ' + err.message)
    }
    setSalvando(false)
  }

  // Microciclo: as 8 semanas do verso do cartão. Sem a IA, o professor
  // preenche aqui na mão.
  async function salvarSemana(numero, campo, valor) {
    const atual = semanas.find(w => w.numero === numero) || { aluno_id: aluno.id, numero }
    const linha = { ...atual, [campo]: valor === '' ? null : valor }
    setSemanas(l => {
      const fora = l.filter(w => w.numero !== numero)
      return [...fora, linha].sort((a, b) => a.numero - b.numero)
    })
    const { error } = await supabase.from('academia_semanas').upsert({
      aluno_id: aluno.id,
      numero,
      series: linha.series ?? null,
      rep_min: linha.rep_min ?? null,
      rep_max: linha.rep_max ?? null,
      sistema: linha.sistema ?? null,
      aumentar_peso: !!linha.aumentar_peso,
    }, { onConflict: 'aluno_id,numero' })
    if (error) setErro(error.message)
  }

  const porGrupo = exercicios.reduce((acc, e) => { (acc[e.grupo] ||= []).push(e); return acc }, {})
  const jaTem = new Set(lista.map(i => i.exercicio_id))

  if (ia) {
    return (
      <form className="al-tela" onSubmit={pedirIa}>
        <header className="al-topo">
          <div className="al-titulo">
            <span className="al-ola">{aluno.nome.split(' ')[0]}</span>
            <h1>Montar com IA</h1>
          </div>
        </header>

        <section className="al-bloco">
          <label className="al-campo">Objetivo
            <select value={ia.objetivo} onChange={e => setIa({ ...ia, objetivo: e.target.value })}>
              <option>Emagrecer</option>
              <option>Ganhar massa</option>
              <option>Condicionamento geral</option>
              <option>Forca</option>
              <option>Voltar a treinar</option>
            </select>
          </label>
          <label className="al-campo">Nivel
            <select value={ia.nivel} onChange={e => setIa({ ...ia, nivel: e.target.value })}>
              <option>Iniciante</option>
              <option>Ja treina</option>
              <option>Avancado</option>
            </select>
          </label>
          <label className="al-campo">Dias por semana
            <select value={ia.dias} onChange={e => setIa({ ...ia, dias: Number(e.target.value) })}>
              {[2, 3, 4, 5, 6].map(d => <option key={d} value={d}>{d} dias</option>)}
            </select>
          </label>
          <label className="al-campo">Alguma restricao?
            <input value={ia.restricoes} onChange={e => setIa({ ...ia, restricoes: e.target.value })} placeholder="joelho, ombro, coluna..." />
          </label>
        </section>

        {(aluno.diabetes || aluno.hipertensao || aluno.cardiopata || aluno.saude_outra) && (
          <div className="al-alerta-saude">
            A IA vai respeitar: {[aluno.diabetes && 'diabetes', aluno.hipertensao && 'hipertensao',
              aluno.cardiopata && 'cardiopata', aluno.saude_outra].filter(Boolean).join(' - ')}
          </div>
        )}

        {erro && <div className="al-erro">{erro}</div>}

        <footer className="al-rodape">
          <button className="al-botao" disabled={pensando}>{pensando ? 'Montando...' : 'Montar treino'}</button>
          <button type="button" className="al-botao texto" onClick={() => { setIa(null); setErro(null) }}>Cancelar</button>
        </footer>
      </form>
    )
  }

  if (plano) {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <div className="al-titulo">
            <span className="al-ola">Rascunho da IA</span>
            <h1>{aluno.nome.split(' ')[0]}</h1>
          </div>
        </header>

        {plano.observacao && <div className="al-alerta-saude">{plano.observacao}</div>}

        {plano.treinos.map(t => (
          <section key={t.letra} className="al-bloco">
            <h2>Treino {t.letra}{t.dia_semana ? ` - ${t.dia_semana}` : ''}{t.foco ? ` - ${t.foco}` : ''}</h2>
            <ul className="al-itens-aluno">
              {t.itens.map((i, n) => (
                <li key={n}>
                  <span className="al-item-num">{n + 1}</span>
                  <span className="al-item-nome">
                    <strong>{i.nome}{i.variacao ? ` (${i.variacao})` : ''}</strong>
                    <small>{i.maquina ? `máquina ${i.maquina}` : 'peso livre'}{i.obs ? ` · ${i.obs}` : ''}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {plano.semanas?.length > 0 && (
          <section className="al-bloco">
            <h2>As 8 semanas</h2>
            <ul className="al-entradas">
              {plano.semanas.map(w => (
                <li key={w.numero}>
                  <span>Semana {w.numero}{w.aumentar_peso ? ' - subir peso' : ''}</span>
                  <strong>{w.series}x {w.rep_min}-{w.rep_max}</strong>
                </li>
              ))}
            </ul>
          </section>
        )}

        {erro && <div className="al-erro">{erro}</div>}

        <footer className="al-rodape">
          <button className="al-botao" disabled={salvando} onClick={usarPlano}>
            {salvando ? 'Salvando...' : 'Usar este treino'}
          </button>
          <button className="al-botao texto" onClick={() => setPlano(null)}>Descartar</button>
        </footer>
      </div>
    )
  }

  if (verSemanas) {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <button className="al-menu-botao" onClick={() => setVerSemanas(false)}>←</button>
          <div className="al-titulo">
            <span className="al-ola">{aluno.nome.split(' ')[0]}</span>
            <h1>As 8 semanas</h1>
          </div>
        </header>

        <p className="al-vazio">
          É o quadro do cartão: o que muda a cada semana. O aluno vê isso no treino dele.
        </p>

        {[1, 2, 3, 4, 5, 6, 7, 8].map(n => {
          const w = semanas.find(x => x.numero === n) || {}
          return (
            <section key={n} className="al-bloco">
              <h2>Semana {n}</h2>
              <div className="al-semana-grade">
                <label className="al-campo">Séries
                  <input inputMode="numeric" value={w.series ?? ''}
                    onChange={e => salvarSemana(n, 'series', e.target.value ? Number(e.target.value) : '')} />
                </label>
                <label className="al-campo">De
                  <input inputMode="numeric" value={w.rep_min ?? ''}
                    onChange={e => salvarSemana(n, 'rep_min', e.target.value ? Number(e.target.value) : '')} />
                </label>
                <label className="al-campo">Até
                  <input inputMode="numeric" value={w.rep_max ?? ''}
                    onChange={e => salvarSemana(n, 'rep_max', e.target.value ? Number(e.target.value) : '')} />
                </label>
              </div>
              <label className="al-campo">Sistema
                <select value={w.sistema ?? ''} onChange={e => salvarSemana(n, 'sistema', e.target.value)}>
                  <option value="">—</option>
                  <option>Série única</option>
                  <option>Bissérie</option>
                </select>
              </label>
              <label className="al-consentimento" style={{ padding: 12 }}>
                <input type="checkbox" checked={!!w.aumentar_peso}
                  onChange={e => salvarSemana(n, 'aumentar_peso', e.target.checked)} />
                <span>Subir o peso nesta semana</span>
              </label>
            </section>
          )
        })}

        <footer className="al-rodape">
          <button className="al-botao" onClick={() => setVerSemanas(false)}>Pronto</button>
        </footer>
      </div>
    )
  }

  if (escolhendo) {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <div className="al-titulo">
            <span className="al-ola">Treino {letra}</span>
            <h1>Escolher exercício</h1>
          </div>
          <button className="al-menu-botao" onClick={() => setEscolhendo(false)}>✕</button>
        </header>

        {novo ? (
          <form className="al-bloco" onSubmit={criarExercicio}>
            <h2>Exercício novo</h2>
            <label className="al-campo">Nome
              <input autoFocus value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} placeholder="Ex.: Agachamento Búlgaro" />
            </label>
            <label className="al-campo">Grupo
              <select value={novo.grupo} onChange={e => setNovo({ ...novo, grupo: e.target.value })}>
                {Object.keys(porGrupo).map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="al-campo">Número da máquina
              <input inputMode="numeric" value={novo.maquina} onChange={e => setNovo({ ...novo, maquina: e.target.value })} placeholder="deixe vazio se for peso livre" />
            </label>
            {erro && <div className="al-erro">{erro}</div>}
            <button className="al-botao" disabled={salvando}>{salvando ? 'Criando...' : 'Criar e adicionar'}</button>
            <button type="button" className="al-botao texto" onClick={() => { setNovo(null); setErro(null) }}>Cancelar</button>
          </form>
        ) : (
          <button className="al-botao secundario" onClick={() => setNovo({ nome: '', grupo: Object.keys(porGrupo)[0] || 'Pernas', maquina: '' })}>
            + Criar exercício que não está na lista
          </button>
        )}

        {Object.entries(porGrupo).map(([grupo, exs]) => (
          <section key={grupo} className="al-bloco">
            <h2>{grupo}</h2>
            <div className="al-exercicios">
              {exs.map(ex => (
                <div key={ex.id} className={`al-exercicio${jaTem.has(ex.id) ? ' marcado' : ''}`}>
                  <button className="al-exercicio-add" disabled={salvando} onClick={() => adicionar(ex)}>
                    <span>{ex.nome}</span>
                    <small>{ex.maquina ? `máq. ${ex.maquina}` : 'peso livre'}</small>
                  </button>
                  <button
                    className={`al-exercicio-video${ex.video_url ? ' tem' : ''}`}
                    title={ex.video_url ? 'Trocar o vídeo' : 'Colar link do vídeo'}
                    onClick={() => mudarVideo(ex)}
                  >🎥</button>
                </div>
              ))}
            </div>
          </section>
        ))}

        <footer className="al-rodape">
          <button className="al-botao" onClick={() => setEscolhendo(false)}>Pronto</button>
        </footer>
      </div>
    )
  }

  return (
    <div className="al-tela">
      <header className="al-topo">
        <button className="al-menu-botao" onClick={onVoltar} aria-label="Voltar">←</button>
        <div className="al-titulo">
          <span className="al-ola">{aluno.matricula ? `nº ${aluno.matricula}` : 'Aluno'}</span>
          <h1>{aluno.nome.split(' ').slice(0, 2).join(' ')}</h1>
        </div>
        {aluno.foto && <img className="al-foto" src={aluno.foto} alt="" />}
      </header>

      {(aluno.diabetes || aluno.hipertensao || aluno.cardiopata || aluno.saude_outra) && (
        <div className="al-alerta-saude">
          ⚠ {[aluno.diabetes && 'diabetes', aluno.hipertensao && 'hipertensão', aluno.cardiopata && 'cardiopata', aluno.saude_outra]
            .filter(Boolean).join(' · ')}
        </div>
      )}

      <div className="al-letras">
        {LETRAS.map(l => {
          const t = treinos.find(x => x.letra === l)
          return (
            <button key={l} className={`al-letra${letra === l ? ' ativa' : ''}${t ? ' tem' : ''}`} onClick={() => setLetra(l)}>
              {l}
              <small>{t?.dia_semana || (t ? `${(itens[t.id] || []).length}` : '—')}</small>
            </button>
          )
        })}
      </div>

      <div className="al-dias">
        {DIAS.map(d => (
          <button
            key={d}
            className={`al-dia${treino?.dia_semana === d ? ' ativo' : ''}`}
            onClick={() => mudarDia(treino?.dia_semana === d ? '' : d)}
          >{d}</button>
        ))}
      </div>

      {erro && <div className="al-erro">{erro}</div>}

      {lista.length === 0 ? (
        <section className="al-bloco">
          <p className="al-vazio">Treino {letra} ainda vazio. Toque em "Adicionar exercício".</p>
        </section>
      ) : (
        <section className="al-bloco">
          <ul className="al-itens">
            {lista.map((i, n) => (
              <li key={i.id}>
                <span className="al-item-num">{n + 1}</span>
                <span className="al-item-nome">
                  <strong>{i.nome}</strong>
                  <small>
                    {i.maquina ? `máquina ${i.maquina}` : 'peso livre'}
                    {cargas[i.id]?.carga ? ` · última carga ${cargas[i.id].carga} kg` : ''}
                  </small>
                </span>
                <select value={i.variacao || ''} onChange={e => mudarVariacao(i, e.target.value)}>
                  {VARIACOES.map(v => <option key={v} value={v}>{v || '—'}</option>)}
                </select>
                <button className="al-item-x" onClick={() => remover(i)} aria-label="Tirar">✕</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="al-rodape">
        <button className="al-botao" onClick={() => setEscolhendo(true)}>+ Adicionar exercício</button>
        <button className="al-botao secundario" onClick={() => setVerSemanas(true)}>
          📅 As 8 semanas{semanas.length ? ` (${semanas.length} montadas)` : ''}
        </button>
        <button
          className="al-botao secundario"
          onClick={() => setIa({ objetivo: aluno.objetivo || 'Condicionamento geral', nivel: 'Iniciante', dias: 3, restricoes: '' })}
        >
          ✨ Montar tudo com IA
        </button>
        {treino && <button className="al-botao texto" onClick={apagarTreino}>Apagar treino {letra}</button>}
      </footer>
    </div>
  )
}
