# Guia para agentes

Extensão do GNOME Shell 50 (Wayland) que exibe monitores de sistema flutuantes no desktop, estilo Conky.

## Estrutura
- `monitores-flutuantes@local/extension.js`: classe `MonitoresFlutuantes` (enable/disable, painel único), `Bar` (barra + histórico opcional), `CoreBars` (uso por núcleo) e `Sparkline` (gráfico Cairo via `St.DrawingArea`).
- `monitores-flutuantes@local/icons/`: ícones SVG dos monitores.
- `monitores-flutuantes@local/wallpapers/`: temas (imagem + `.json` opcional com `nome` e `painel`).
- Configuração do usuário: `~/.config/monitores-flutuantes.json` (`left`, `tema`, `clima`).
- `monitores-flutuantes@local/stylesheet.css`: classes `.mf-*`.
- `monitores-flutuantes@local/metadata.json`: `shell-version` deve conter a versão do Shell em uso.

## Convenções
- ESM da extensão GNOME 50: `import ... from 'gi://...'` e `resource:///org/gnome/shell/...`.
- Métricas lidas de `/proc`, `/sys`, GIO e NetworkManager; não adicionar dependências externas nem subprocessos. Únicas consultas de rede: IP público (ipify) e clima (Open-Meteo), via `Soup` em `_poll`.
- Tudo criado em `enable()` deve ser destruído/desconectado em `disable()` (timeouts, signals, actors).
- Código e comentários em português, no estilo existente (poucos comentários, só onde o porquê não é óbvio).
- Wayland não recarrega o Shell: mudanças só aparecem após logout/login. Para testar sem isso: `dbus-run-session -- gnome-shell --devkit` (se disponível).

## Verificação
- Sintaxe: copiar `extension.js` para `.mjs` e rodar `node --check`.
- Erros em runtime: `journalctl -f -o cat /usr/bin/gnome-shell`.

## Git
- Repositório: github.com/radmog/MonitorWayland, branch `main`.
- Commits e push são delegados ao agente `git-commit-push`.
