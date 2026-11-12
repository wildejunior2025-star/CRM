import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { semanaAtual, hojeIso } from '../../lib/microciclo'
import { curto } from '../../lib/diaSemana'
import { linkDoVideo } from '../../lib/videoExercicio'
import { useAuth } from '../../hooks/useAuth'

// O professor monta o treino do aluno pelo celular, do mesmo jeito que fazia
// no cartão: escolhe os treinos A a E, marca o dia e vai marcando os
// exercícios de cada grupo. O número da máquina vem junto.

const LETRAS = ['A', 'B', 'C', 'D', 'E', 'F']
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const VARIACOES = ['', 'H', 'UNI', 'ABERTO', 'CROSS']

export default function ProfessorTreino({ aluno, app, onVoltar }) {
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
  const [modelos, setModelos] = useState(null)   // null = nao abriu a tela
  const [salvandoModelo, setSalvandoModelo] = useState(false)
  const [inicioCiclo, setInicioCiclo] = useState(aluno.microciclo_inicio || null)
  const [contato, setContato] = useState(null)   // { final, tem_conta, entra_app }
  const [recado, setRecado] = useState(null)
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

  // Só os 4 últimos do celular. O instrutor confere com o aluno na frente dele
  // ("termina em 2505?") sem ficar com a lista de telefones da academia.
  useEffect(() => {
    supabase.rpc('academia_contato_do_aluno', { p_aluno: aluno.id })
      .then(({ data }) => { if (data?.ok) setContato(data) })
  }, [aluno.id])

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
    const link = window.prompt(
      `Link do vídeo de ${ex.nome} (deixe vazio para tirar).`
      + '\nVale pra TODOS os alunos que fizerem este exercício:', atual)
    if (link === null) return
    const { error } = await supabase
      .from('academia_exercicios')
      .update({ video_url: link.trim() || null })
      .eq('id', ex.id)
    if (error) return setErro(error.message)
    setExercicios(l => l.map(x => (x.id === ex.id ? { ...x, video_url: link.trim() || null } : x)))
  }

  // O vídeo fica no EXERCÍCIO (academia_exercicios), não no item do treino:
  // prendeu uma vez, vale pra todo aluno que fizer aquele exercício.
  const videoDe = item => exercicios.find(e => e.id === item.exercicio_id)?.video_url || null

  async function mudarVideoDoItem(item) {
    const ex = exercicios.find(e => e.id === item.exercicio_id)
    if (!ex) return setErro('Este exercício foi apagado da lista da academia.')
    await mudarVideo(ex)
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
    // O que ele escolheu vale pra ficha também: da próxima vez já vem certo,
    // na recepção e em qualquer treino.
    if (ia.sexo && ia.sexo !== aluno.sexo) {
      await supabase.from('academia_alunos').update({ sexo: ia.sexo }).eq('id', aluno.id)
    }
    const { data, error } = await supabase.functions.invoke('montar-treino', {
      body: {
        exercicios: exercicios.map(x => ({ id: x.id, nome: x.nome, grupo: x.grupo, maquina: x.maquina })),
        aluno: {
          nome: aluno.nome, objetivo: aluno.objetivo, sexo: ia.sexo || aluno.sexo,
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
    // Isto APAGA o que o aluno ja tinha. Se tem exercicio montado la, pergunta
    // antes: o professor pode ter passado meia hora montando na mao, e depois
    // de salvo nao da pra voltar.
    const quantos = Object.values(itens).reduce((n, l) => n + l.length, 0)
    if (quantos > 0) {
      const ok = window.confirm(
        `${aluno.nome.split(' ')[0]} já tem ${treinos.length} treino${treinos.length === 1 ? '' : 's'} `
        + `com ${quantos} exercício${quantos === 1 ? '' : 's'}. Usar este rascunho APAGA tudo isso `
        + 'e põe o da IA no lugar. Não dá pra voltar atrás.\n\nPode apagar?')
      if (!ok) return
    }
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
            // A IA responde "Quinta"; o resto do sistema fala "Qui".
            letra: t.letra, dia_semana: curto(t.dia_semana), nome: t.foco || null,
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
      // Treino novo, ciclo novo: a contagem das 8 semanas recomeca hoje.
      await supabase.from('academia_alunos')
        .update({ microciclo_inicio: hojeIso() }).eq('id', aluno.id)
      setInicioCiclo(hojeIso())
      setPlano(null)
      await carregar()
    } catch (err) {
      setErro('Nao deu pra salvar: ' + err.message)
    }
    setSalvando(false)
  }

  // ── Contato e senha do aluno ──────────────────────────────────────────
  //
  // O "não consigo entrar no app" aparece aqui, com o aluno na frente dele.
  // Mandar voltar na recepção por causa disso é perder o aluno no caminho.
  async function trocarTelefone() {
    const novo = window.prompt(
      'Peça o número ao aluno e digite com DDD.'
      + '\nEle vira o jeito de entrar no app:')
    if (novo === null) return
    setErro(null)
    setRecado(null)
    const { data, error } = await supabase.rpc('academia_trocar_telefone_aluno', {
      p_aluno: aluno.id, p_telefone: novo,
    })
    if (error) return setErro(error.message)
    if (!data?.ok) return setErro(data?.erro || 'Não deu pra trocar.')
    const { data: c } = await supabase.rpc('academia_contato_do_aluno', { p_aluno: aluno.id })
    if (c?.ok) setContato(c)
    // Só promete a senha nova quando ela realmente acompanhou: quem já entrou
    // no app tem senha própria, e o gatilho não mexe nela.
    setRecado(data.senha_acompanhou
      ? `Pronto. O número agora termina em ${data.final}, e é essa a senha dele no app.`
      : `Pronto, número trocado. A senha do app continua a que ele já usava — se tiver esquecido, toque em "Redefinir a senha".`)
  }

  async function redefinirSenha() {
    const nova = window.prompt(
      'Senha nova do aluno — 4 números.'
      + '\nEle usa pra entrar no app, com o telefone dele:',
      contato?.final || '')
    if (nova === null) return
    setErro(null)
    setRecado(null)
    const { data, error } = await supabase.rpc('academia_redefinir_senha_aluno', {
      p_aluno: aluno.id, p_senha: nova,
    })
    if (error) return setErro(error.message)
    if (!data?.ok) return setErro(data?.erro || 'Não deu pra redefinir.')
    setRecado('Senha trocada. Diga os 4 números pro aluno e peça pra ele entrar agora.')
  }

  // ── Modelos de treino ─────────────────────────────────────────────────
  //
  // Um professor e 460 alunos: montar exercicio por exercicio pra cada um nao
  // acontece. Ele monta tres ou quatro treinos bons e aplica em um toque.
  //
  // O modelo guarda o plano no MESMO formato do rascunho da IA, entao cai na
  // mesma tela de conferir e no mesmo "Usar este treino" — sem caminho novo.
  async function abrirModelos() {
    setErro(null)
    const { data, error } = await supabase
      .from('academia_modelos')
      .select('id, nome, observacao, plano')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    if (error) return setErro(error.message)
    setModelos(data || [])
  }

  // Transforma o que esta montado agora no formato do plano.
  function planoDeAgora() {
    return {
      resumo: null,
      treinos: treinos.map(t => ({
        letra: t.letra,
        dia_semana: t.dia_semana || null,
        foco: t.nome || null,
        itens: (itens[t.id] || []).map(i => ({
          id: i.exercicio_id, nome: i.nome, maquina: i.maquina,
          variacao: i.variacao || null, obs: i.observacao || null,
        })),
      })),
      semanas: semanas.map(w => ({
        numero: w.numero, series: w.series, rep_min: w.rep_min,
        rep_max: w.rep_max, sistema: w.sistema, aumentar_peso: !!w.aumentar_peso,
      })),
    }
  }

  async function salvarComoModelo() {
    const quantos = Object.values(itens).reduce((n, l) => n + l.length, 0)
    if (!quantos) return setErro('Monte o treino primeiro — não dá pra guardar um modelo vazio.')
    const nome = window.prompt('Nome do modelo (ex.: Iniciante 3x, Emagrecimento 5x):')
    if (!nome?.trim()) return
    setSalvandoModelo(true)
    const { error } = await supabase.from('academia_modelos').insert({
      empresa_id: profile.empresa_id,
      nome: nome.trim(),
      observacao: `${treinos.length} treinos · ${quantos} exercícios`,
      plano: planoDeAgora(),
      criado_por: profile.id,
    })
    setSalvandoModelo(false)
    if (error) return setErro(error.message)
    setErro(null)
    window.alert(`Modelo "${nome.trim()}" guardado. Agora é só aplicar nos outros alunos.`)
  }

  async function apagarModelo(m) {
    if (!window.confirm(`Apagar o modelo "${m.nome}"? Os alunos que já receberam continuam com o treino.`)) return
    await supabase.from('academia_modelos').delete().eq('id', m.id)
    abrirModelos()
  }

  // Microciclo: as 8 semanas do verso do cartão. Sem a IA, o professor
  // preenche aqui na mão.
  // Recomecar o ciclo: volta pra semana 1 a partir de hoje.
  async function recomecarCiclo() {
    const hoje = hojeIso()
    await supabase.from('academia_alunos').update({ microciclo_inicio: hoje }).eq('id', aluno.id)
    setInicioCiclo(hoje)
  }

  async function salvarSemana(numero, campo, valor) {
    // Primeira semana preenchida na mao: o ciclo passa a contar de hoje.
    if (!inicioCiclo) recomecarCiclo()
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
          {/* A IA montava o mesmo treino pra homem e pra mulher: o sexo estava
              na ficha, mas a tela do professor nem buscava esse campo, e em
              173 dos 476 alunos ele esta vazio. Agora ele escolhe aqui, com o
              aluno na frente, e o que escolher fica gravado na ficha. */}
          <label className="al-campo">Treino para
            <select value={ia.sexo} onChange={e => setIa({ ...ia, sexo: e.target.value })}>
              <option value="">Não informar</option>
              <option value="F">Mulher</option>
              <option value="M">Homem</option>
            </select>
          </label>
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
    const temTreinoMontado = Object.values(itens).reduce((n, l) => n + l.length, 0)
    return (
      <div className="al-tela">
        <header className="al-topo">
          <div className="al-titulo">
            <span className="al-ola">{plano.deModelo ? `Modelo: ${plano.deModelo}` : 'Rascunho da IA'}</span>
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
          {temTreinoMontado > 0 && (
            <p className="al-aviso-apaga">
              ⚠ {aluno.nome.split(' ')[0]} já tem {temTreinoMontado} exercício
              {temTreinoMontado === 1 ? '' : 's'} montado{temTreinoMontado === 1 ? '' : 's'}.
              Usar este apaga o que está lá.
            </p>
          )}
          <button className="al-botao texto" onClick={() => setPlano(null)}>Descartar</button>
        </footer>
      </div>
    )
  }

  if (modelos) {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <button className="al-menu-botao" onClick={() => setModelos(null)}>←</button>
          <div className="al-titulo">
            <span className="al-ola">{aluno.nome.split(' ')[0]}</span>
            <h1>Modelos de treino</h1>
          </div>
        </header>

        <p className="al-vazio">
          Monte um treino bom uma vez, guarde como modelo e aplique nos outros
          alunos em um toque. Depois de aplicar, dá pra ajustar o que for
          diferente pra cada um.
        </p>

        {erro && <div className="al-erro">{erro}</div>}

        {modelos.length === 0 && (
          <section className="al-bloco">
            <p className="al-texto">Nenhum modelo guardado ainda.</p>
          </section>
        )}

        {modelos.map(m => (
          <section key={m.id} className="al-bloco">
            <div className="al-modelo">
              <span>
                <strong>{m.nome}</strong>
                <small>{m.observacao || `${m.plano?.treinos?.length || 0} treinos`}</small>
              </span>
              <button className="al-botao" onClick={() => { setPlano({ ...m.plano, deModelo: m.nome }); setModelos(null) }}>
                Usar
              </button>
            </div>
            <button className="al-botao texto" onClick={() => apagarModelo(m)}>Apagar modelo</button>
          </section>
        ))}

        <footer className="al-rodape">
          <button className="al-botao secundario" disabled={salvandoModelo} onClick={salvarComoModelo}>
            {salvandoModelo ? 'Guardando...' : `💾 Guardar o treino de ${aluno.nome.split(' ')[0]} como modelo`}
          </button>
        </footer>
      </div>
    )
  }

  if (verSemanas) {
    const montadas = semanas.filter(w => w.series || w.rep_min).length
    const ondeEstou = semanaAtual(inicioCiclo, montadas)
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

        {/* Onde o aluno está AGORA. Sem isto o professor montava as 8 semanas
            sem nunca saber se elas estavam andando — e elas não estavam. */}
        {montadas > 0 && (
          <div className={`al-ciclo-cartao${ondeEstou.terminou ? ' acabou' : ''}`}>
            <div>
              <strong>
                {ondeEstou.terminou
                  ? `Ciclo terminado (${montadas} semanas)`
                  : `Semana ${ondeEstou.numero} de ${montadas}`}
              </strong>
              <small>
                {inicioCiclo
                  ? `Começou em ${String(inicioCiclo).slice(0, 10).split('-').reverse().join('/')}`
                  : 'Ainda não começou a contar'}
                {ondeEstou.terminou ? ' · hora de remontar o treino' : ''}
              </small>
            </div>
            <button className="al-botao texto" onClick={recomecarCiclo}>Recomeçar hoje</button>
          </div>
        )}

        {[1, 2, 3, 4, 5, 6, 7, 8].map(n => {
          const w = semanas.find(x => x.numero === n) || {}
          return (
            <section key={n} className="al-bloco">
              <h2>
                Semana {n}
                {montadas > 0 && !ondeEstou.terminou && n === ondeEstou.numero && (
                  <span className="al-tag ok" style={{ marginLeft: 8 }}>é esta</span>
                )}
              </h2>
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

      {/* Avisa ANTES de ele montar: sem telefone no cadastro o aluno não
          entra no app, e o treino não chega em ninguém. */}
      {app && !app.entra_app && (
        <div className="al-sem-app">
          <strong>Este aluno não vê o treino no celular</strong>
          <span>
            {app.falta === 'telefone'
              ? 'Falta o telefone no cadastro — é com ele que o aluno entra no app. Peça pra passar na recepção e deixar o número.'
              : 'Ele ainda não tem conta no app. A recepção cria em dois toques, no cadastro dele.'}
          </span>
        </div>
      )}

      {/* Contato e senha do app. O instrutor resolve o "não consigo entrar"
          aqui mesmo, com o aluno na frente dele, sem mandar voltar na
          recepção — e sem ficar com a lista de telefones da academia: o
          número vem mascarado do servidor, ele nunca recebe o inteiro. */}
      {contato && (
        <div className="al-contato">
          <span className="al-contato-linha">
            <small>Celular do aluno</small>
            <strong>{contato.mascara || 'não tem no cadastro'}</strong>
          </span>
          <span className="al-contato-botoes">
            <button className="al-botao secundario" onClick={trocarTelefone}>
              {contato.mascara ? 'Trocar o número' : 'Pôr o número'}
            </button>
            {contato.tem_conta && (
              <button className="al-botao secundario" onClick={redefinirSenha}>
                Redefinir a senha
              </button>
            )}
          </span>
          <small className="al-contato-dica">
            Confira com o aluno se o fim do número é esse. É com ele que o aluno
            entra no app.
          </small>
        </div>
      )}

      {recado && <div className="al-recado">{recado}</div>}

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
                  {/* O mesmo vídeo que o aluno vê, aqui também: o professor
                      mostra a execução na hora, do lado do aparelho, sem ter
                      que abrir o YouTube na mão. */}
                  <span className="al-video-linha">
                    <a className="al-video" href={linkDoVideo(i.nome, videoDe(i))}
                      target="_blank" rel="noreferrer">
                      {videoDe(i) ? '▶ ver como faz' : '▶ procurar no YouTube'}
                    </a>
                    <button className="al-video-trocar" onClick={() => mudarVideoDoItem(i)}>
                      {videoDe(i) ? 'trocar vídeo' : 'prender um vídeo'}
                    </button>
                  </span>
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
          onClick={() => setIa({ objetivo: aluno.objetivo || 'Condicionamento geral', nivel: 'Iniciante', dias: 3, restricoes: '', sexo: aluno.sexo || '' })}
        >
          ✨ Montar tudo com IA
        </button>
        <button className="al-botao secundario" onClick={abrirModelos}>
          📋 Usar um modelo
        </button>
        {treino && <button className="al-botao texto" onClick={apagarTreino}>Apagar treino {letra}</button>}
      </footer>
    </div>
  )
}
