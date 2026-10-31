# Guia para agentes

Extensão do GNOME Shell 50 (Wayland) que exibe monitores de sistema flutuantes no desktop, estilo Conky.

## Estrutura
- `monitores-flutuantes@local/extension.js`: classe `MonitoresFlutuantes` (enable/disable), `Bar` (barra + histórico opcional) e `Sparkline` (gráfico Cairo via `St.DrawingArea`).
- `monitores-flutuantes@local/stylesheet.css`: classes `.mf-*`.
- `monitores-flutuantes@local/metadata.json`: `shell-version` deve conter a versão do Shell em uso.

## Convenções
- ESM da extensão GNOME 50: `import ... from 'gi://...'` e `resource:///org/gnome/shell/...`.
- Métricas lidas de `/proc` e GIO; não adicionar dependências externas nem subprocessos.
- Tudo criado em `enable()` deve ser destruído/desconectado em `disable()` (timeouts, signals, actors).
- Código e comentários em português, no estilo existente (poucos comentários, só onde o porquê não é óbvio).
- Wayland não recarrega o Shell: mudanças só aparecem após logout/login. Para testar sem isso: `dbus-run-session -- gnome-shell --devkit` (se disponível).

## Verificação
- Sintaxe: copiar `extension.js` para `.mjs` e rodar `node --check`.
- Erros em runtime: `journalctl -f -o cat /usr/bin/gnome-shell`.

## Git
- Repositório: github.com/radmog/MonitorWayland, branch `main`.
- Commits e push são delegados ao agente `git-commit-push`.
