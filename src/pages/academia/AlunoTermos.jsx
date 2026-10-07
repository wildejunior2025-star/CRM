import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'

// Primeira vez que o aluno entra: ele aceita o uso do rosto. Quem assina é
// ELE, não a academia — uma caixinha marcada pelo dono não vale nada (ponto
// levantado pelo usuário em 07/10/2026). Fica gravada a data do aceite.

export default function AlunoTermos({ aluno, onAceitou }) {
  const { logout } = useAuth()
  const [marcado, setMarcado] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  async function aceitar() {
    setSalvando(true)
    setErro(null)
    const { error } = await supabase
      .from('academia_alunos')
      .update({ consentimento_em: new Date().toISOString() })
      .eq('id', aluno.id)
    setSalvando(false)
    if (error) return setErro('Não deu pra salvar: ' + error.message)
    onAceitou()
  }

  return (
    <div className="al-tela">
      <header className="al-topo">
        <div className="al-titulo">
          <span className="al-ola">Bem-vindo,</span>
          <h1>{aluno.nome.split(' ')[0]}</h1>
        </div>
      </header>

      <section className="al-bloco">
        <h2>Entrada pelo rosto</h2>
        <p className="al-texto">
          A academia usa o reconhecimento facial pra liberar a catraca. Antes de começar, você precisa
          autorizar. É rápido e você pode mudar de ideia depois.
        </p>
        <ul className="al-dicas">
          <li>A sua foto é usada <b>só pra liberar a sua entrada</b> na academia.</li>
          <li>Ela fica guardada em segurança e <b>não é passada pra ninguém</b>.</li>
          <li>Também fica registrado o dia e a hora em que você entra.</li>
          <li>Você pode pedir pra apagar sua foto quando quiser, na recepção.</li>
          <li>Se preferir não cadastrar o rosto, a recepção libera sua entrada na mão.</li>
        </ul>
      </section>

      <label className="al-consentimento">
        <input type="checkbox" checked={marcado} onChange={e => setMarcado(e.target.checked)} />
        <span>
          Li e <b>autorizo</b> a academia a usar o meu rosto para liberar a minha entrada, conforme a
          Lei Geral de Proteção de Dados.
        </span>
      </label>

      {erro && <div className="al-erro">{erro}</div>}

      <footer className="al-rodape">
        <button className="al-botao" disabled={!marcado || salvando} onClick={aceitar}>
          {salvando ? 'Salvando...' : 'Continuar'}
        </button>
        <button className="al-botao texto" onClick={logout}>Agora não, sair</button>
      </footer>
    </div>
  )
}
