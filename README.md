# EntreTela

Uma única sala para você e seus amigos compartilharem tela com som e conversarem por voz. Até **10 pessoas no total**, incluindo quem transmite. Versão **0.2.2**, Windows x64.

[Baixar EntreTela 0.2.2 para Windows](https://github.com/joaobuild/EntreTela/releases/download/v0.2.2/EntreTela-0.2.2-Windows.exe) · [Página da versão](https://github.com/joaobuild/EntreTela/releases/tag/v0.2.2)

## Como entrar

1. Todos fecham a versão anterior e abrem `EntreTela-0.2.2-Windows.exe`.
2. Para usar de casas diferentes, conectem os dois computadores à mesma rede do **Radmin VPN**.
3. Em **ambos os computadores**, com o Radmin ligado, cliquem em **Permitir conexão no Windows** e aceitem o pedido de administrador do Windows (UAC). Isso permite que qualquer um dos dois hospede a sala ao entrar primeiro.
4. Cada pessoa informa somente seu nome e clica em **Entrar na sala**. O aplicativo encontra a sala automaticamente: o primeiro participante hospeda no próprio computador e os próximos entram na mesma sala.
5. Cada pessoa que quiser falar clica em **Ativar microfone** no próprio computador. O microfone começa desligado. Para ouvir os amigos ou assistir à tela, não é necessário ativar o microfone.
6. Clique em **Compartilhar tela** para mostrar uma tela ou janela. Quem está assistindo pode clicar em **Tela cheia** no vídeo recebido; pressione **Esc** para sair da tela cheia.

**Não há senha, convite, código de sala ou escolha entre várias salas.** Se a sala já tiver dez pessoas, aguarde alguém sair. Se o anfitrião sair, outro participante conectado tenta assumir; depois da reconexão, a tela precisa ser compartilhada novamente.

## Rede necessária

Na mesma rede local, todos precisam estar em uma rede que permita comunicação entre os computadores. De casas diferentes, todos precisam estar na **mesma rede Radmin VPN ou ZeroTier**, com descoberta local/broadcast permitida.

O botão **Permitir conexão no Windows** configura regras de entrada TCP e UDP para o executável que roda o EntreTela. Quando o Radmin está ligado, as regras ficam limitadas à interface e à sub-rede do Radmin. Sem Radmin, usam as interfaces e sub-redes locais disponíveis. O botão exige confirmação do Windows e não desliga o firewall. Cada participante precisa liberar a conexão no próprio computador, pois qualquer participante pode ser o anfitrião. Firewalls de outros fornecedores podem exigir uma permissão equivalente.

A versão 0.2.2 mantém as correções de conexão da 0.2.1 para computadores com vários adaptadores de rede, como Wi-Fi e Radmin ao mesmo tempo. O programa mantém endereços alternativos de cada participante e tenta outras conexões quando um endereço falha. As mensagens de erro mostram o endereço tentado e a causa da falha para ajudar no diagnóstico.

A descoberta usa broadcast UDP 45873. A coordenação usa uma porta TCP dinâmica e a mídia usa WebRTC. Redes que bloqueiam descoberta, isolam clientes Wi-Fi ou não encaminham broadcasts podem impedir que os participantes encontrem a sala. Nessa situação, corrijam a rede ou VPN; não há entrada por convite ou endereço nesta versão.

A sala única é encontrada entre os computadores alcançáveis da mesma rede. Não existe uma sala global na internet nem um servidor de cadastro: computadores em redes isoladas não conseguem saber quem abriu primeiro. A aplicação não atravessa qualquer NAT/CGNAT sozinha e não inclui STUN/TURN. A VPN possui infraestrutura própria, mas não exige que você mantenha um servidor EntreTela.

Como não há senha ou autenticação, **qualquer pessoa na mesma rede alcançável pode entrar**. Usem a rede local ou VPN da turma. Nomes servem apenas para identificação na interface. Publicar o código no GitHub não libera acesso à rede de vocês.

O áudio e o vídeo são cifrados pelo WebRTC. A sinalização desta versão não usa uma chave compartilhada ou senha: a privacidade do tráfego de coordenação depende da rede/VPN utilizada. Não há gravação, conta ou serviço EntreTela na nuvem.

## Tela com som, sem repetir as vozes

A versão 0.2.2 corrige uma falha da 0.2.1 em que os participantes apareciam online e o transmissor via a própria prévia, mas o outro computador não reproduzia a tela ou a voz recebida. A correção associa cada trilha recebida ao elemento correto da interface e também permite usar tela cheia no aplicativo Windows.

Microfone, vídeo e som da tela usam trilhas separadas. O programa não reproduz o próprio microfone nem o som da própria prévia. A captura solicita `restrictOwnAudio: true` para excluir as vozes reproduzidas pelo EntreTela do som compartilhado e verifica a configuração retornada antes de transmitir som.

Use **Windows 11** para o recurso completo. A API de exclusão por processo exige build 20348 ou posterior. Versões comuns do Windows 10, como build 19045, ficam restritas à tela sem som. Se a exclusão não for confirmada, o programa interrompe a captura com som e permite tentar novamente desmarcando essa opção.

Use fones: o cancelamento de eco ajuda, mas não garante eliminar todo eco acústico dos alto-falantes. Uma chamada aberta em outro aplicativo, como Discord, pode ser capturada; façam a conversa pelo EntreTela. Mesmo quando uma janela é escolhida, o áudio capturado é o som do computador com exclusão do EntreTela, e não somente daquela janela. Conteúdo protegido pode aparecer preto ou sem áudio.

## Desempenho

Uma pessoa compartilha por vez. O padrão é 720p/24 fps, com opções 480p/15 fps e 1080p/30 fps. O transmissor envia uma cópia para cada espectador. O limite solicitado para vídeo é até 8 Mbit/s somando os destinatários, sem contar áudio, cabeçalhos e retransmissões. Voz usa até 40 kbit/s por destinatário e som da tela até 96 kbit/s por destinatário.

O modo 480p reduz o consumo. Electron/Chromium não produz um binário ultrapequeno; desempenho e qualidade com nove espectadores dependem de CPU, GPU e upload de quem transmite. Ainda não houve ensaio com dez computadores físicos.

## Atualização e testes

Todos devem atualizar para a versão 0.2.2 para receber as correções de reprodução e tela cheia, além das correções de conexão da 0.2.1. Ela não se conecta às salas com senha da versão 0.1.0. Fechem o EntreTela antes de substituir ou abrir outro executável: a versão portátil usa uma pasta de execução estável para manter o caminho das permissões do firewall entre atualizações.

Testes automatizados cobrem entrada somente com nome, descoberta da mesma sala, entradas simultâneas, troca de anfitrião, limite de dez pessoas, recusa de sala cheia sem criar outra, versões incompatíveis, mensagens malformadas e exclusividade da transmissão.

O teste anterior de mídia verificava a chegada de RTP, mas podia passar mesmo sem reprodução na interface. A regressão da 0.2.1 criava seis transceivers em vez de três, e o receptor ignorava trilhas adicionais. A versão 0.2.2 mantém três funções fixas — voz, vídeo da tela e som da tela — associadas pelos identificadores `mid` da negociação WebRTC.

O teste de integração usa a interface real com duas janelas e mídia sintética. Além do tráfego recebido, verifica `srcObject`, dimensões do vídeo (`videoWidth`), avanço de `currentTime`, estado `paused` e tela cheia do espectador. Cobre transmissão nos dois sentidos, microfone ativado antes ou depois da entrada do outro participante, som separado, limite de bitrate, prévia sem áudio e controles de silenciar/parar.

Os testes locais e de mídia sintética não substituem uma chamada entre dois computadores físicos pelo Radmin. Essa validação, a captura de áudio real com exclusão das vozes e o desempenho com dez computadores ainda precisam de ensaio prático. O teste gráfico local usa `--no-sandbox` apenas por restrições do ambiente automatizado. O programa distribuído mantém o sandbox do renderer, isolamento de contexto e ponte nativa restrita.

## Desenvolvimento

Repositório público: [joaobuild/EntreTela](https://github.com/joaobuild/EntreTela).

Com Node.js 24 instalado:

```powershell
npm ci
npm test
npm run test:media
npm start
npm run dist
```

O executável é gerado em `release/EntreTela-0.2.2-Windows.exe`. O GitHub Actions também executa os testes e gera um artefato Windows a cada envio para o repositório. O executável não possui assinatura comercial de código.

## Referências e licença

- [Correção de exclusão do áudio próprio no Electron](https://releases.electronjs.org/pr/52455)
- [API de captura por processo do Windows](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Verificação de restrictOwnAudio](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/restrictOwnAudio)

Código EntreTela sob licença MIT. Electron, Chromium e demais dependências mantêm suas próprias licenças.
