# EntreTela

Aplicativo para Windows x64: uma tela com som e conversa por voz para até **10 pessoas no total**, incluindo quem transmite. Versão inicial 0.1.0.

## Como usar

1. Todos abrem `EntreTela-0.1.0-Windows.exe`. Não é necessário instalar Node.js para usar o executável.
2. Na mesma rede, combinem uma senha de grupo de pelo menos 8 caracteres. Usem uma frase longa e exclusiva. Cada pessoa informa seu nome e essa senha e clica em **Entrar na sala**. O primeiro a entrar inicia o servidor de coordenação no próprio computador.
3. De casas diferentes, conectem os computadores à **mesma rede virtual Radmin VPN ou ZeroTier**. O primeiro entra no EntreTela, clica em **Copiar convite** e envia o texto aos amigos. Os demais colam o convite no aplicativo. O convite inclui a senha; compartilhe somente com a turma.
4. Permitam a comunicação do EntreTela pelo Firewall do Windows na rede utilizada. Isso também é necessário nos computadores que poderão assumir a sala. A aplicação não altera regras do firewall sozinha.
5. Clique em **Ativar microfone** para conversar. Ele começa desligado.
6. Clique em **Compartilhar tela**, escolha a tela ou janela e mantenha a opção de som marcada, se disponível. Uma pessoa transmite por vez. A qualidade inicial é 720p a até 24 quadros por segundo.
7. Use **Parar transmissão** para encerrar a tela e **Sair** para desconectar.

Se o anfitrião sair, os membros restantes tentam assumir a sala seguindo a ordem de entrada. A reconexão exige que eles consigam alcançar uns aos outros. Pode levar alguns segundos; a tela precisa ser compartilhada novamente. Copiem um novo convite depois da troca, pois o endereço anterior pertence ao anfitrião antigo.

## Tela com som sem repetir as vozes

O microfone, o vídeo e o som da tela usam trilhas separadas. O aplicativo não reproduz seu próprio microfone nem o som de sua própria prévia.

A captura solicita `restrictOwnAudio: true` para excluir a reprodução da própria chamada do áudio compartilhado. O programa verifica o suporte e a configuração retornada pelo Windows antes de transmitir som. Se a confirmação não estiver disponível, a transmissão com som é interrompida; ainda é possível compartilhar a tela desmarcando o som.

Use **Windows 11** para o recurso completo. A API de exclusão de áudio de processos requer build **20348 ou posterior**; versões comuns do Windows 10, como build 19045, ficam restritas à tela sem som nesta versão. O Electron está fixado em 44.3.0, que inclui a correção de encaminhamento dessa opção.

Use fones. O cancelamento de eco do microfone ajuda com som vindo dos alto-falantes, mas não garante eliminar todo eco acústico. Vozes reproduzidas por **outros aplicativos**, como uma chamada do Discord aberta em paralelo, não pertencem à chamada do EntreTela e podem entrar no som transmitido. Façam a conversa pelo EntreTela.

Ao compartilhar uma janela, o som solicitado é o **som do computador**, com exclusão do EntreTela; ele não fica restrito àquela janela. Conteúdo protegido pode aparecer preto ou sem áudio.

## Rede e desempenho

- Não existe servidor EntreTela na nuvem, login, gravação ou serviço de retransmissão configurado. O servidor local só encaminha mensagens para conectar os participantes; áudio e vídeo trafegam diretamente por WebRTC.
- A descoberta automática usa UDP 45873. A coordenação usa uma porta TCP local dinâmica, incluída no convite. WebRTC usa portas de mídia negociadas automaticamente.
- Sem uma rede alcançável entre os computadores, não há conexão. Esta versão **não atravessa qualquer NAT/CGNAT sozinha** e não inclui STUN/TURN. Serviços de VPN têm infraestrutura própria; não são servidores EntreTela mantidos por você.
- Se a descoberta automática for bloqueada pelo roteador ou VPN, use o convite. O convite inclui os endereços IPv4 das interfaces do anfitrião e tenta alcançá-los. Interfaces indisponíveis podem tornar a entrada mais lenta.
- A senha define o grupo; nomes não autenticam a identidade pessoal. Todos os convidados têm permissão de falar e solicitar compartilhamento. Não há painel de moderação nesta versão.
- A sinalização é criptografada com AES-256-GCM, com chave derivada por scrypt. O WebRTC cifra a mídia em trânsito. Endereços de rede e existência do grupo não ficam ocultos de outros dispositivos na rede.
- O transmissor envia uma cópia para cada espectador. O orçamento configurado para vídeo é de **até 8 Mbit/s somando os destinatários**, sem contar áudio, cabeçalhos e retransmissões. Para nove espectadores, isso reduz o limite de vídeo por destinatário a aproximadamente 889 kbit/s. A qualidade real se adapta à rede.
- Voz: até 40 kbit/s por destinatário; som compartilhado: até 96 kbit/s por destinatário. Esses valores são limites solicitados ao navegador, não garantias de tráfego exato.
- O modo 480p/15 fps reduz o trabalho do computador. O modo 1080p/30 fps exige mais. Apenas uma captura de tela é aberta; ainda há até nove conexões e codificações de saída.
- O aplicativo usa Electron/Chromium, portanto não é um binário ultrapequeno. O desempenho com dez pessoas depende do processador, da placa de vídeo e do upload de quem transmite. Ainda não houve ensaio com dez computadores físicos.

## Verificação realizada

- Testes automatizados: criptografia e adulteração, convites inválidos, entrada de dez pessoas e rejeição da décima primeira, roteamento sem falsificar remetente, exclusividade da transmissão, saída de participantes, IDs duplicados e troca de anfitrião.
- Teste de integração em duas janelas: conexão WebRTC real, microfones sintéticos nos dois sentidos, vídeo sintético decodificado, som da tela em trilha separada, limite de bitrate aplicado, prévia sem áudio, silenciamento e encerramento da transmissão.
- A restrição `restrictOwnAudio` foi detectada no runtime usado. **A captura de áudio real com exclusão das vozes ainda requer validação em dois computadores**, assim como firewall, VPN e desempenho com dez usuários.
- O teste gráfico local precisou de `--no-sandbox` por restrições do ambiente de execução automatizado. Esse parâmetro **não é usado pelo aplicativo distribuído**, que mantém isolamento de contexto, sandbox do renderer e acesso restrito à ponte nativa.

## Código e GitHub

O código-fonte está incluído. O projeto contém um fluxo GitHub Actions em `.github/workflows/windows.yml` para testar e gerar o executável ao enviar o projeto a um repositório. Repositório: https://github.com/joaobuild/EntreTela (privado).

Com Node.js 24 instalado, na pasta do projeto:

```powershell
npm ci
npm test
npm start
```

Para teste de mídia sintética e geração do executável:

```powershell
npm run test:media
npm run dist
```

O executável fica em `release/EntreTela-0.1.0-Windows.exe`. Não há assinatura comercial de código nesta versão.

## Referências técnicas

- [Correção do Electron para excluir o áudio próprio](https://releases.electronjs.org/pr/52455)
- [Configuração de captura de tela no Electron](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [API de captura de áudio por processo do Windows](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Verificação de restrictOwnAudio](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/restrictOwnAudio)

## Licença

Código do EntreTela sob licença MIT. Electron, Chromium e demais dependências têm suas próprias licenças, incluídas no pacote distribuído.
