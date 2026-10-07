import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import TecladoPin from './TecladoPin'

// Perfil do aluno: foto, nome, telefone, e-mail e senha. Abre pela gaveta.

export default function AlunoPerfil({ aluno, onSalvou, onTrocarFoto }) {
  const [nome, setNome] = useState(aluno.nome || '')
  const [telefone, setTelefone] = useState(aluno.telefone || '')
  const [email, setEmail] = useState(aluno.email || '')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [salvo, setSalvo] = useState(false)
  const [trocandoSenha, setTrocandoSenha] = useState(false)

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
    onSalvou?.()
    setTimeout(() => setSalvo(false), 2500)
  }

  if (trocandoSenha) return <TrocarSenha onPronto={() => setTrocandoSenha(false)} />

  return (
    <form onSubmit={salvar} className="al-conteudo">
      <button type="button" className="al-foto-grande" onClick={onTrocarFoto}>
        {aluno.foto
          ? <img src={aluno.foto} alt="" />
          : <span className="al-foto-vazia grande">+</span>}
        <span>{aluno.descritores?.length ? 'Trocar foto' : 'Cadastrar foto'}</span>
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
          {salvando ? 'Salvando...' : salvo ? 'Salvo ✓' : 'Salvar'}
        </button>
      </section>

      <button type="button" className="al-linha" onClick={() => setTrocandoSenha(true)}>
        <span>Senha</span>
        <small>4 números · toque para trocar</small>
      </button>
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
    // Caminho próprio da academia: o Supabase exige 6 caracteres e a nossa
    // senha é um PIN de 4 números (mig 0301).
    const { error } = await supabase.rpc('academia_trocar_minha_senha', { p_senha: pin })
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
      <section className="al-bloco">
        <h2>Senha trocada</h2>
        <p className="al-texto">Da próxima vez, entre com o seu telefone e esses 4 números.</p>
        <button className="al-botao" onClick={onPronto} style={{ marginTop: 14 }}>Voltar</button>
      </section>
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
