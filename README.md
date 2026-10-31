# MonitorWayland

Monitores flutuantes no desktop, no estilo Conky, para **GNOME Shell 50 (Wayland)**.

O GNOME não suporta `wlr-layer-shell`, então o Conky não consegue se fixar no desktop. Esta extensão desenha um painel de monitoramento na camada de fundo do Shell, atrás das janelas e acima do papel de parede.

## O que mostra

- Relógio e data
- CPU, memória, swap e disco `/` (barras: amarelo > 75%, vermelho > 90%)
- Gráficos de histórico (sparklines) de 60 s para CPU, memória e rede
- Rede (download/upload), carga do sistema e uptime

Atualização a cada segundo. Os dados vêm de `/proc` e do GIO, sem dependências externas.

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

Arraste o painel com o botão esquerdo do mouse. Clique com o botão direito para alternar o tema. A posição e o tema ficam salvos em `~/.config/monitores-flutuantes.json`.

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
└── wallpapers/      # temas: imagem + .json opcional
```

## Ideias futuras

Temperaturas e GPU, múltiplos painéis, tela de preferências.
