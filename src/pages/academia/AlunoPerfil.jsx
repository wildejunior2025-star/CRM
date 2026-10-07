import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import TecladoPin from './TecladoPin'

// Perfil do aluno: abre tocando na foto. Aqui mora tudo que não precisa estar
// na tela inicial — foto, dados, senha e o histórico de entradas.

export default function AlunoPerfil({ aluno, entradas, onVoltar, onTrocarFoto }) {
  const { logout } = useAuth()
  const [tela, setTela] = useState('perfil') // perfil | senha | entradas
  const [nome, setNome] = useState(aluno.nome || '')
  const [telefone, setTelefone] = useState(aluno.telefone || '')
  const [email, setEmail] = useState(aluno.email || '')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [salvo, setSalvo] = useState(false)

  async function salvar(e) {
    e.preventDefault()
    if (!nome.trim()) return setErro('Coloque seu nome.')
    setSalvando(true)
    setErro(null)
    const { error } = await supabase
      .from('academia_alunos')
      .update({
        nome: nome.trim(),
        telefone: telefone.replace(/\D/g, '') || null,
        email: email.trim() || null,
      })
      .eq('id', aluno.id)
    setSalvando(false)
    if (error) return setErro('Não deu pra salvar: ' + error.message)
    setSalvo(true)
    setTimeout(() => setSalvo(false), 2500)
  }

  if (tela === 'senha') return <TrocarSenha onPronto={() => setTela('perfil')} />

  if (tela === 'entradas') {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <div>
            <span className="al-ola">Você treinou</span>
            <h1>Minhas entradas</h1>
          </div>
        </header>
        <section className="al-bloco">
          {entradas.length === 0 ? (
            <p className="al-vazio">Nenhuma entrada ainda. A primeira é quando você passar na catraca.</p>
          ) : (
            <ul className="al-entradas">
              {entradas.map((e, i) => {
                const d = new Date(e.criado_em)
                return (
                  <li key={i}>
                    <span>{d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
                    <strong>{d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <footer className="al-rodape">
          <button className="al-botao secundario" onClick={() => setTela('perfil')}>Voltar</button>
        </footer>
      </div>
    )
  }

  return (
    <form className="al-tela" onSubmit={salvar}>
      <header className="al-topo">
        <div>
          <span className="al-ola">Sua conta</span>
          <h1>Perfil</h1>
        </div>
        <button type="button" className="al-foto-botao" onClick={onTrocarFoto} title="Trocar foto">
          {aluno.foto
            ? <img className="al-foto" src={aluno.foto} alt="" />
            : <span className="al-foto al-foto-vazia">+</span>}
        </button>
      </header>

      <button type="button" className="al-linha" onClick={onTrocarFoto}>
        <span>{aluno.descritores?.length ? 'Trocar minha foto' : 'Cadastrar minha foto'}</span>
        <small>É ela que abre a catraca</small>
      </button>

      <section className="al-bloco">
        <label className="al-campo">Nome
          <input value={nome} onChange={e => setNome(e.target.value)} />
        </label>
        <label className="al-campo">Telefone
          <input inputMode="tel" value={telefone} onChange={e => setTelefone(e.target.value)} placeholder="(84) 99999-9999" />
        </label>
        <label className="al-campo">E-mail
          <input type="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="opcional" />
        </label>
        {erro && <div className="al-erro">{erro}</div>}
        <button className="al-botao" disabled={salvando}>
          {salvando ? 'Salvando...' : salvo ? 'Salvo ✓' : 'Salvar meus dados'}
        </button>
      </section>

      <button type="button" className="al-linha" onClick={() => setTela('senha')}>
        <span>Trocar minha senha</span>
        <small>4 números</small>
      </button>

      <button type="button" className="al-linha" onClick={() => setTela('entradas')}>
        <span>Minhas entradas</span>
        <small>{entradas.length} registradas</small>
      </button>

      <footer className="al-rodape">
        <button type="button" className="al-botao secundario" onClick={onVoltar}>Voltar</button>
        <button type="button" className="al-botao texto" onClick={logout}>Sair da conta</button>
      </footer>
    </form>
  )
}

// A senha do aluno é de 4 números: é o que ele digita no teclado do login.
function TrocarSenha({ onPronto }) {
  const [etapa, setEtapa] = useState('nova') // nova | repetir | pronta
  const [primeira, setPrimeira] = useState('')
  const [erro, setErro] = useState(null)
  const [salvando, setSalvando] = useState(false)

  async function confirmar(pin) {
    if (etapa === 'nova') {
      setPrimeira(pin)
      setErro(null)
      setEtapa('repetir')
      return
    }
    if (pin !== primeira) {
      setErro('Os números não bateram. Comece de novo.')
      setPrimeira('')
      setEtapa('nova')
      return
    }
    setSalvando(true)
    const { error } = await supabase.auth.updateUser({ password: pin })
    setSalvando(false)
    if (error) {
      setErro('Não deu pra trocar: ' + error.message)
      setEtapa('nova')
      return
    }
    setEtapa('pronta')
  }

  if (etapa === 'pronta') {
    return (
      <div className="al-tela">
        <header className="al-topo"><div><span className="al-ola">Tudo certo</span><h1>Senha trocada</h1></div></header>
        <section className="al-bloco">
          <p className="al-texto">Da próxima vez, entre com o seu telefone e esses 4 números.</p>
        </section>
        <footer className="al-rodape">
          <button className="al-botao" onClick={onPronto}>Voltar</button>
        </footer>
      </div>
    )
  }

  return (
    <TecladoPin
      titulo={etapa === 'nova' ? 'Nova senha' : 'Repita a senha'}
      subtitulo={etapa === 'nova' ? 'Escolha 4 números que você lembre' : 'Digite os mesmos 4 números'}
      erro={erro}
      carregando={salvando}
      onCompleto={confirmar}
      onVoltar={onPronto}
    />
  )
}
