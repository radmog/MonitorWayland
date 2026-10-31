# MonitorWayland

Monitores flutuantes no desktop, no estilo Conky, para **GNOME Shell 50 (Wayland)**.

O GNOME não suporta `wlr-layer-shell`, então o Conky não consegue se fixar no desktop. Esta extensão desenha um painel de monitoramento na camada de fundo do Shell, atrás das janelas e acima do papel de parede.

## O que mostra

Um único painel, com ícones SVG em cada monitor:

- Relógio e data
- CPU com histórico, uso por núcleo e frequência
- Memória (com histórico) e disco `/` (barras: amarelo > 75%, vermelho > 90%)
- Temperatura da CPU (hwmon) com histórico
- Bateria (`BAT0`–`BAT3`), quando existir: barra que alerta com carga baixa
- Rede (download/upload) com histórico, IP e SSID da conexão primária (NetworkManager), IP público e IP do Tailscale
- Clima atual e previsão de 5 dias (Open-Meteo)
- Calendário do mês e próximos eventos (mesmo serviço de calendário do GNOME)

Métricas de sistema atualizam a cada segundo e vêm de `/proc`, `/sys`, GIO, D-Bus e libs do próprio Shell. O IP público (`api.ipify.org`, a cada 10 min) e o clima (`open-meteo.com`, a cada 30 min) são as únicas consultas à internet; em caso de falha, tentam de novo em até 1 min.

## Requisitos

- Ubuntu com GNOME Shell 50 e sessão Wayland

## Instalação

```bash
git clone https://github.com/radmog/MonitorWayland.git
cd MonitorWayland
ln -s "$PWD/monitores-flutuantes@local" ~/.local/share/gnome-shell/extensions/monitores-flutuantes@local
```

No Wayland o Shell não recarrega sem encerrar a sessão: faça **logout/login** e então:

```bash
gnome-extensions enable monitores-flutuantes@local
```

## Uso

Arraste o painel com o botão esquerdo do mouse. Clique com o botão direito para alternar o tema. A posição e o tema são salvos em `~/.config/monitores-flutuantes.json` ao soltar o painel ou trocar de tema (o arquivo só é criado nesse momento).

### Cidade do clima

O padrão é Manaus - AM. Para mudar, edite o arquivo de configuração:

```json
{"clima": {"cidade": "São Paulo - SP", "lat": -23.55, "lon": -46.63}}
```

`cidade` é só o texto exibido; `lat` e `lon` definem a previsão. Requer logout/login (ou desabilitar e habilitar a extensão).

## Temas

Cada imagem (`.png`, `.jpg`, `.jpeg`, `.webp`) em `monitores-flutuantes@local/wallpapers/` é um tema: ao ativá-lo a extensão troca o papel de parede do GNOME e, ao desabilitar a extensão, restaura o original. Um `.json` de mesmo nome da imagem é opcional:

```json
{"nome": "Amazônia – Manaus", "painel": "rgba(8, 28, 20, 0.62)"}
```

`nome` identifica o tema (padrão: nome do arquivo) e `painel` é a cor de fundo do painel.

## Depuração

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Estrutura

```
monitores-flutuantes@local/
├── metadata.json    # UUID e versões do Shell suportadas
├── extension.js     # lógica, widgets e coleta de métricas
├── stylesheet.css   # estilo do painel
├── icons/           # ícones SVG dos monitores
└── wallpapers/      # temas: imagem + .json opcional
```

## Ideias futuras

GPU, tela de preferências (cidade do clima, itens exibidos).
