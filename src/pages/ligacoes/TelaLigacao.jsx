import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import Opcoes from './Opcoes'
import { SIM_NAO, digitos, primeiroNome } from './util'

// Tela da atendente (mig 0292). Fluxo: "Próxima loja" trava uma loja pra ela
// (quem clica primeiro leva, some pra fila das outras) → liga → marca as respostas
// → salva → próxima. Nada de lista de lojas: ela só enxerga a que está na mão.

const RESULTADOS = [
  { v: 'atendeu', t: 'Atendeu' },
  { v: 'dono_ausente', t: 'Dono ausente' },
  { v: 'nao_atendeu', t: 'Não atendeu' },
  { v: 'caixa_postal', t: 'Caixa postal' },
  { v: 'numero_errado', t: 'Número errado' },
]
const QUEM_ATENDE = [
  { v: 'dono', t: 'Dono' },
  { v: 'funcionario', t: 'Funcionário' },
  { v: 'outro', t: 'Outro' },
]
const DESFECHOS = [
  { v: 'visita', t: 'Marcou visita' },
  { v: 'retornar', t: 'Ligar depois' },
  { v: 'sem_interesse', t: 'Sem interesse' },
]
const MOTIVOS = [
  'Já tem sistema e está satisfeito',
  'Acha caro',
  'Não é o momento',
  'Não é o dono / não decide',
  'Não quis explicar',
  'Outro',
]

const VAZIO = {
  resultado: null, usa: null, qualSistema: '', ifood: null, quemAtende: null, quemNome: '',
  entregador: null, desfecho: null, visitaEm: '', visitaQuem: '', retornoEm: '', motivo: '',
  nomeDono: '', melhorHorario: '', obs: '',
}

function dataLocalIso(str) {
  return str ? new Date(str).toISOString() : null
}

export default function TelaLigacao({ nome, onSair }) {
  const [lead, setLead] = useState(null)
  const [f, setF] = useState(VAZIO)
  const [resumo, setResumo] = useState({ ligacoes: 0, atendeu: 0, visitas: 0 })
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [vazio, setVazio] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)

  const set = (campo) => (valor) => setF((x) => ({ ...x, [campo]: valor }))

  const carregarResumo = useCallback(async () => {
    const { data } = await supabase.rpc('tm_meu_resumo')
    if (data) setResumo(data)
  }, [])

  const pegarProxima = useCallback(async () => {
    setCarregando(true)
    setErro(null)
    setVazio(false)
    const { data, error } = await supabase.rpc('tm_pegar_proximo')
    setCarregando(false)
    if (error) { setErro(error.message); return }
    const l = Array.isArray(data) ? data[0] : data
    if (!l?.id) { setLead(null); setVazio(true); return }
    setLead(l)
    setF({ ...VAZIO, nomeDono: l.nome_dono || '' })
    window.scrollTo({ top: 0 })
  }, [])

  // Ao abrir: se ela já está com uma loja na mão (atualizou a página), volta pra ela.
  useEffect(() => {
    carregarResumo()
    pegarProxima()
  }, [carregarResumo, pegarProxima])

  async function devolver() {
    if (!lead) return
    await supabase.rpc('tm_liberar', { p_lead: lead.id })
    setLead(null)
    setF(VAZIO)
    setVazio(false)
  }

  const atendeu = f.resultado === 'atendeu'
  const podeSalvar = !!f.resultado && (!atendeu || (
    f.usa !== null && f.ifood !== null && !!f.desfecho
    && (f.desfecho !== 'visita' || !!f.visitaEm)
    && (f.desfecho !== 'retornar' || !!f.retornoEm)
    && (f.desfecho !== 'sem_interesse' || !!f.motivo)
  ))

  async function salvar() {
    if (!podeSalvar || salvando) return
    setSalvando(true)
    setErro(null)
    const dados = {
      resultado: f.resultado,
      nome_dono: f.nomeDono.trim() || null,
      melhor_horario: f.melhorHorario.trim() || null,
      observacao: f.obs.trim() || null,
    }
    if (atendeu) {
      Object.assign(dados, {
        usa_sistema: f.usa,
        qual_sistema: f.usa ? f.qualSistema.trim() || null : null,
        vende_ifood: f.ifood,
        quem_atende: f.quemAtende,
        quem_atende_nome: f.quemNome.trim() || null,
        entregador_proprio: f.entregador,
        desfecho: f.desfecho,
        visita_em: f.desfecho === 'visita' ? dataLocalIso(f.visitaEm) : null,
        visita_quem: f.desfecho === 'visita' ? f.visitaQuem.trim() || null : null,
        retorno_em: f.desfecho === 'retornar' ? dataLocalIso(f.retornoEm) : null,
        motivo_nao: f.desfecho === 'sem_interesse' ? f.motivo : null,
      })
    }
    const { error } = await supabase.rpc('tm_registrar_ligacao', { p_lead: lead.id, p_dados: dados })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setAviso(f.desfecho === 'visita' ? 'Visita marcada! O Wilde já foi avisado. 🎉' : 'Ligação salva ✓')
    setTimeout(() => setAviso(null), 3500)
    setLead(null)
    setF(VAZIO)
    carregarResumo()
  }

  const tel = lead ? digitos(lead.telefone) : ''
  const nomeDono = primeiroNome(lead?.nome_dono)
  const abertura = nomeDono
    ? `"Oi, boa tarde! Eu queria falar com o ${nomeDono}, por favor. É da FWC Inter."`
    : '"Oi, boa tarde! Aqui é a ' + (primeiroNome(nome) || '[seu nome]') + ', da FWC Inter. Eu falo com o responsável pela ' + (lead?.loja || '[loja]') + '?"'

  return (
    <div className="lg-tela">
      <header className="lg-topo">
        <div>
          <strong>Olá, {primeiroNome(nome) || 'atendente'}</strong>
          <div className="lg-resumo">
            Hoje: <b>{resumo.ligacoes}</b> ligações · <b>{resumo.atendeu}</b> atenderam · <b>{resumo.visitas}</b> visitas
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onSair}>Sair</button>
      </header>

      {aviso && <div className="lg-ok">{aviso}</div>}
      {erro && <div className="lg-erro">{erro}</div>}

      {!lead && (
        <div className="lg-card lg-centro">
          {carregando ? (
            <p className="lg-muted">Procurando uma loja...</p>
          ) : (
            <>
              {vazio && <p className="lg-muted">Não tem mais lojas na fila por agora. Tente de novo daqui a pouco.</p>}
              <button className="lg-grande" onClick={pegarProxima}>📞 Próxima loja</button>
              <p className="lg-muted lg-peq">A loja fica só com você até você salvar.</p>
            </>
          )}
        </div>
      )}

      {lead && (
        <>
          <section className="lg-card">
            <h2 className="lg-loja">{lead.loja}</h2>
            <div className="lg-muted">
              {[lead.tipo, [lead.bairro, lead.cidade].filter(Boolean).join(' · ')].filter(Boolean).join(' — ')}
            </div>
            {lead.endereco && <div className="lg-muted lg-peq">{lead.endereco}</div>}
            <div className="lg-chips">
              {lead.nota ? <span className="lg-chip">⭐ {lead.nota}{lead.avaliacoes ? ` (${lead.avaliacoes})` : ''}</span> : null}
              <span className="lg-chip">Tentativa {lead.tentativas + 1} de 3</span>
              {lead.nome_dono && <span className="lg-chip lg-chip-dono">👤 {lead.nome_dono}</span>}
            </div>
            {lead.melhor_horario && <div className="lg-dica">Melhor horário: {lead.melhor_horario}</div>}
            <a className="lg-ligar" href={`tel:+${tel.startsWith('55') ? tel : '55' + tel}`}>
              📞 Ligar — {lead.telefone}
            </a>
            <div className="lg-roteiro">
              <div className="lg-rot-t">O que dizer</div>
              <div>{abertura}</div>
            </div>
          </section>

          <section className="lg-card">
            <h3 className="lg-h">1. Como foi a ligação?</h3>
            <Opcoes valor={f.resultado} onChange={set('resultado')} opcoes={RESULTADOS} grande />
          </section>

          {f.resultado === 'dono_ausente' && (
            <section className="lg-card lg-form">
              <h3 className="lg-h">Anote pra ligar de novo</h3>
              <label>Nome do dono (se souber)
                <input value={f.nomeDono} onChange={(e) => set('nomeDono')(e.target.value)} />
              </label>
              <label>Que horário ele costuma estar?
                <input value={f.melhorHorario} onChange={(e) => set('melhorHorario')(e.target.value)} placeholder="ex: depois das 15h" />
              </label>
            </section>
          )}

          {atendeu && (
            <>
              <section className="lg-card lg-form">
                <h3 className="lg-h">2. As perguntas</h3>

                <div className="lg-perg">
                  <div className="lg-q">"Hoje vocês usam algum <b>sistema</b> pra controlar pedido e caixa, ou é no caderno/WhatsApp mesmo?"</div>
                  <Opcoes valor={f.usa} onChange={set('usa')} opcoes={SIM_NAO} />
                  {f.usa === true && (
                    <input className="lg-in" placeholder="Qual sistema?" value={f.qualSistema} onChange={(e) => set('qualSistema')(e.target.value)} />
                  )}
                </div>

                <div className="lg-perg">
                  <div className="lg-q">"Vocês vendem pelo <b>iFood</b>?"</div>
                  <Opcoes valor={f.ifood} onChange={set('ifood')} opcoes={SIM_NAO} />
                </div>

                <div className="lg-perg">
                  <div className="lg-q">"Quem <b>atende o WhatsApp</b> da loja? É você mesmo?"</div>
                  <Opcoes valor={f.quemAtende} onChange={set('quemAtende')} opcoes={QUEM_ATENDE} />
                  {f.quemAtende && (
                    <input className="lg-in" placeholder="Nome de quem atende (opcional)" value={f.quemNome} onChange={(e) => set('quemNome')(e.target.value)} />
                  )}
                </div>

                <div className="lg-perg">
                  <div className="lg-q">Se a conversa estiver boa: "Tem <b>entregador próprio</b>?" <span className="lg-muted">(opcional)</span></div>
                  <Opcoes valor={f.entregador} onChange={set('entregador')} opcoes={SIM_NAO} />
                </div>

                <label>Nome do dono (se descobriu)
                  <input value={f.nomeDono} onChange={(e) => set('nomeDono')(e.target.value)} />
                </label>
              </section>

              <section className="lg-card lg-form">
                <h3 className="lg-h">3. Como terminou?</h3>
                <Opcoes valor={f.desfecho} onChange={set('desfecho')} opcoes={DESFECHOS} grande />

                {f.desfecho === 'visita' && (
                  <>
                    <label>Dia e hora da visita
                      <input type="datetime-local" value={f.visitaEm} onChange={(e) => set('visitaEm')(e.target.value)} />
                    </label>
                    <label>Quem vai receber o Wilde?
                      <input value={f.visitaQuem} onChange={(e) => set('visitaQuem')(e.target.value)} placeholder="nome do dono / quem atende" />
                    </label>
                  </>
                )}
                {f.desfecho === 'retornar' && (
                  <label>Quando ligar de novo?
                    <input type="datetime-local" value={f.retornoEm} onChange={(e) => set('retornoEm')(e.target.value)} />
                  </label>
                )}
                {f.desfecho === 'sem_interesse' && (
                  <label>Por quê?
                    <select value={f.motivo} onChange={(e) => set('motivo')(e.target.value)}>
                      <option value="">Escolha o motivo</option>
                      {MOTIVOS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                )}
              </section>
            </>
          )}

          {f.resultado && (
            <section className="lg-card lg-form">
              <label>Observação (opcional)
                <textarea rows={3} value={f.obs} onChange={(e) => set('obs')(e.target.value)} />
              </label>
            </section>
          )}

          <div className="lg-acoes">
            <button className="btn btn-secondary" onClick={devolver} disabled={salvando}>Devolver pra fila</button>
            <button className="btn btn-primary lg-salvar" onClick={salvar} disabled={!podeSalvar || salvando}>
              {salvando ? 'Salvando...' : 'Salvar ligação'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
