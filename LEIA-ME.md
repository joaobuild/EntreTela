# EntreTela

Uma única sala para você e seus amigos compartilharem tela com som e conversarem por voz. Até **10 pessoas no total**, incluindo quem transmite. Versão **0.2.0**, Windows x64.

[Baixar a versão 0.2.0](https://github.com/joaobuild/EntreTela/releases/tag/v0.2.0)

## Como entrar

1. Todos abrem `EntreTela-0.2.0-Windows.exe`.
2. Cada pessoa informa somente seu nome e clica em **Entrar na sala**.
3. O aplicativo encontra a sala automaticamente. O primeiro participante hospeda no próprio computador; os próximos entram na mesma sala.
4. Clique em **Ativar microfone** para conversar ou **Compartilhar tela** para mostrar uma tela ou janela. O microfone começa desligado.

**Não há senha, convite, código de sala ou escolha entre várias salas.** Se a sala já tiver dez pessoas, aguarde alguém sair. Se o anfitrião sair, outro participante conectado tenta assumir; depois da reconexão, a tela precisa ser compartilhada novamente.

## Rede necessária

Na mesma rede local, basta entrar. De casas diferentes, todos precisam estar na **mesma rede Radmin VPN ou ZeroTier**, com descoberta local/broadcast permitida. Permitam o EntreTela no firewall da rede utilizada, em todos os computadores. O aplicativo não muda regras de firewall.

A descoberta usa broadcast UDP 45873. A coordenação usa uma porta TCP dinâmica e a mídia usa WebRTC. Redes que bloqueiam descoberta, isolam clientes Wi-Fi ou não encaminham broadcasts podem impedir que os participantes encontrem a sala. Nessa situação, corrijam a rede ou VPN; não há entrada por convite ou endereço nesta versão.

A sala única é encontrada entre os computadores alcançáveis da mesma rede. Não existe uma sala global na internet nem um servidor de cadastro: computadores em redes isoladas não conseguem saber quem abriu primeiro. A aplicação não atravessa qualquer NAT/CGNAT sozinha e não inclui STUN/TURN. A VPN possui infraestrutura própria, mas não exige que você mantenha um servidor EntreTela.

Como não há senha ou autenticação, **qualquer pessoa na mesma rede alcançável pode entrar**. Usem a rede local ou VPN da turma. Nomes servem apenas para identificação na interface. Publicar o código no GitHub não libera acesso à rede de vocês.

O áudio e o vídeo são cifrados pelo WebRTC. A sinalização desta versão não usa uma chave compartilhada ou senha: a privacidade do tráfego de coordenação depende da rede/VPN utilizada. Não há gravação, conta ou serviço EntreTela na nuvem.

## Tela com som, sem repetir as vozes

Microfone, vídeo e som da tela usam trilhas separadas. O programa não reproduz o próprio microfone nem o som da própria prévia. A captura solicita `restrictOwnAudio: true` para excluir as vozes reproduzidas pelo EntreTela do som compartilhado e verifica a configuração retornada antes de transmitir som.

Use **Windows 11** para o recurso completo. A API de exclusão por processo exige build 20348 ou posterior. Versões comuns do Windows 10, como build 19045, ficam restritas à tela sem som. Se a exclusão não for confirmada, o programa interrompe a captura com som e permite tentar novamente desmarcando essa opção.

Use fones: o cancelamento de eco ajuda, mas não garante eliminar todo eco acústico dos alto-falantes. Uma chamada aberta em outro aplicativo, como Discord, pode ser capturada; façam a conversa pelo EntreTela. Mesmo quando uma janela é escolhida, o áudio capturado é o som do computador com exclusão do EntreTela, e não somente daquela janela. Conteúdo protegido pode aparecer preto ou sem áudio.

## Desempenho

Uma pessoa compartilha por vez. O padrão é 720p/24 fps, com opções 480p/15 fps e 1080p/30 fps. O transmissor envia uma cópia para cada espectador. O limite solicitado para vídeo é até 8 Mbit/s somando os destinatários, sem contar áudio, cabeçalhos e retransmissões. Voz usa até 40 kbit/s por destinatário e som da tela até 96 kbit/s por destinatário.

O modo 480p reduz o consumo. Electron/Chromium não produz um binário ultrapequeno; desempenho e qualidade com nove espectadores dependem de CPU, GPU e upload de quem transmite. Ainda não houve ensaio com dez computadores físicos.

## Atualização e testes

Todos devem usar a versão 0.2.0. Ela não se conecta às salas com senha da versão 0.1.0.

Testes automatizados cobrem entrada somente com nome, descoberta da mesma sala, entradas simultâneas, troca de anfitrião, limite de dez pessoas, recusa de sala cheia sem criar outra, versões incompatíveis, mensagens malformadas e exclusividade da transmissão. O teste de integração usa a interface real com duas janelas e mídia sintética para verificar áudio nos dois sentidos, vídeo decodificado, som separado, limite de bitrate, prévia sem áudio e controles de silenciar/parar.

A captura de áudio real com exclusão das vozes e o desempenho com dez computadores ainda precisam de validação prática. O teste gráfico local usa `--no-sandbox` apenas por restrições do ambiente automatizado. O programa distribuído mantém o sandbox do renderer, isolamento de contexto e ponte nativa restrita.

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

O executável é gerado em `release/EntreTela-0.2.0-Windows.exe`. O GitHub Actions também executa os testes e gera um artefato Windows a cada envio para o repositório. O executável não possui assinatura comercial de código.

## Referências e licença

- [Correção de exclusão do áudio próprio no Electron](https://releases.electronjs.org/pr/52455)
- [API de captura por processo do Windows](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Verificação de restrictOwnAudio](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/restrictOwnAudio)

Código EntreTela sob licença MIT. Electron, Chromium e demais dependências mantêm suas próprias licenças.
