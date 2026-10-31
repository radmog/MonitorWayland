import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_SECONDS = 1;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const PANEL_BG_DEFAULT = 'rgba(15, 17, 22, 0.62)';
const DECODER = new TextDecoder();
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'];
const DISK_DEVICE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const TOP_PROCESSES = 4;
const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

function readText(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? DECODER.decode(bytes) : '';
    } catch (e) {
        return '';
    }
}

function formatBytes(n) {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

// Caminho do sensor de temperatura da CPU: o primeiro hwmon de CPU_SENSORS, por ordem de preferência.
function findCpuTempPath() {
    const found = {};
    for (let i = 0; i < 32; i++) {
        const base = `/sys/class/hwmon/hwmon${i}`;
        const name = readText(`${base}/name`).trim();
        if (name && !(name in found) && readText(`${base}/temp1_input`))
            found[name] = `${base}/temp1_input`;
    }
    const name = CPU_SENSORS.find(n => n in found);
    return name ? found[name] : null;
}

function findBatteryPath() {
    for (let i = 0; i < 4; i++) {
        const base = `/sys/class/power_supply/BAT${i}`;
        if (readText(`${base}/capacity`))
            return base;
    }
    return null;
}

// Gráfico de histórico: uma ou mais séries desenhadas com Cairo.
// `max` fixo (ex.: 1 para frações) ou null para auto-escala.
class Sparkline {
    constructor(parent, colors, {max = null, samples = 60} = {}) {
        this._colors = colors;
        this._max = max;
        this._samples = samples;
        this._series = colors.map(() => []);

        this.actor = new St.DrawingArea({style_class: 'mf-spark', x_expand: true, height: 28});
        this.actor.connect('repaint', area => this._draw(area));
        parent.add_child(this.actor);
    }

    push(...values) {
        values.forEach((v, i) => {
            const s = this._series[i];
            s.push(v);
            if (s.length > this._samples)
                s.shift();
        });
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const max = this._max ?? Math.max(1, ...this._series.flat());
        const step = w / (this._samples - 1);

        cr.setLineWidth(1.2);
        this._series.forEach((s, i) => {
            if (s.length < 2)
                return;
            const [r, g, b] = this._colors[i];
            const x0 = w - (s.length - 1) * step;
            const y = v => h - 1 - Math.min(1, v / max) * (h - 2);

            cr.moveTo(x0, y(s[0]));
            for (let k = 1; k < s.length; k++)
                cr.lineTo(x0 + k * step, y(s[k]));
            cr.setSourceRGBA(r, g, b, 1);
            cr.strokePreserve();

            cr.lineTo(w, h);
            cr.lineTo(x0, h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.18);
            cr.fill();
        });
        cr.$dispose();
    }
}

class Bar {
    constructor(parent, label, {history = false, historyMax = 1, invert = false} = {}) {
        this._invert = invert;
        const row = new St.BoxLayout({x_expand: true});
        this._label = new St.Label({text: label, style_class: 'mf-label', x_expand: true});
        this._value = new St.Label({text: '-', style_class: 'mf-value'});
        row.add_child(this._label);
        row.add_child(this._value);
        parent.add_child(row);

        this._bg = new St.Widget({style_class: 'mf-bar-bg', x_expand: true, layout_manager: new Clutter.BinLayout()});
        this._fill = new St.Widget({style_class: 'mf-bar-fill', x_align: Clutter.ActorAlign.START});
        this._bg.add_child(this._fill);
        parent.add_child(this._bg);

        this._spark = history ? new Sparkline(parent, [[0.38, 0.63, 0.92]], {max: historyMax}) : null;
    }

    // `invert`: valores baixos são o estado ruim (ex.: bateria).
    update(fraction, text, {alert = true} = {}) {
        fraction = Math.max(0, Math.min(1, fraction));
        this._spark?.push(fraction);
        this._value.text = text;
        const width = this._bg.width;
        this._fill.width = Math.round(width * fraction);
        const level = this._invert ? 1 - fraction : fraction;
        const state = !alert ? '' : level > 0.9 ? ' crit' : level > 0.75 ? ' warn' : '';
        this._fill.style_class = `mf-bar-fill${state}`;
    }
}

export default class MonitoresFlutuantes extends Extension {
    enable() {
        this._configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'monitores-flutuantes.json']);
        this._prevCpu = null;
        this._prevNet = null;
        this._prevDisk = null;
        this._prevProcs = null;
        this._tempPath = findCpuTempPath();
        this._batteryPath = findBatteryPath();
        this._dragging = false;
        this._bgSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._bgOriginal = {
            light: this._bgSettings.get_string('picture-uri'),
            dark: this._bgSettings.get_string('picture-uri-dark'),
        };

        this._buildPanel();
        this._themes = this._loadThemes();
        this._loadConfig();
        Main.layoutManager._backgroundGroup.add_child(this._panel);

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._endDrag();
        if (this._bgSettings) {
            this._bgSettings.set_string('picture-uri', this._bgOriginal.light);
            this._bgSettings.set_string('picture-uri-dark', this._bgOriginal.dark);
        }
        this._bgSettings = null;
        this._themes = null;
        this._panel?.destroy();
        this._panel = null;
        this._bars = null;
    }

    // Cada imagem em wallpapers/ é um tema; um .json de mesmo nome pode definir
    // `nome` e `painel` (cor de fundo do painel).
    _loadThemes() {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'wallpapers']));
        const themes = [];
        try {
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const file = info.get_name();
                const ext = IMAGE_EXTENSIONS.find(e => file.toLowerCase().endsWith(e));
                if (!ext)
                    continue;
                const base = file.slice(0, -ext.length);
                let meta = {};
                try {
                    meta = JSON.parse(readText(dir.get_child(`${base}.json`).get_path()));
                } catch (e) {
                    // sem metadados: usa os padrões
                }
                themes.push({
                    nome: meta.nome ?? base,
                    painel: meta.painel ?? PANEL_BG_DEFAULT,
                    uri: dir.get_child(file).get_uri(),
                });
            }
        } catch (e) {
            console.error(`monitores-flutuantes: falha ao listar wallpapers: ${e}`);
        }
        return themes.sort((a, b) => a.nome.localeCompare(b.nome));
    }

    _applyTheme(index) {
        if (!this._themes.length)
            return;
        this._themeIndex = ((index % this._themes.length) + this._themes.length) % this._themes.length;
        const theme = this._themes[this._themeIndex];
        this._bgSettings.set_string('picture-uri', theme.uri);
        this._bgSettings.set_string('picture-uri-dark', theme.uri);
        this._panel.set_style(`background-color: ${theme.painel};`);
    }

    _buildPanel() {
        this._panel = new St.BoxLayout({
            vertical: true,
            style_class: 'mf-panel',
            reactive: true,
            track_hover: true,
        });

        this._clock = new St.Label({style_class: 'mf-clock'});
        this._date = new St.Label({style_class: 'mf-date'});
        this._panel.add_child(this._clock);
        this._panel.add_child(this._date);
        this._panel.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));

        this._bars = {
            cpu: new Bar(this._panel, 'CPU', {history: true}),
            mem: new Bar(this._panel, 'Memória', {history: true}),
            swap: new Bar(this._panel, 'Swap'),
            disk: new Bar(this._panel, 'Disco /'),
        };
        if (this._tempPath)
            this._bars.temp = new Bar(this._panel, 'Temperatura', {history: true, historyMax: 1});
        if (this._batteryPath)
            this._bars.battery = new Bar(this._panel, 'Bateria', {invert: true});

        this._panel.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._net = new St.Label({style_class: 'mf-label'});
        this._panel.add_child(this._net);
        // verde = download, laranja = upload
        this._netSpark = new Sparkline(this._panel, [[0.34, 0.8, 0.52], [0.96, 0.47, 0]]);
        this._diskIo = new St.Label({style_class: 'mf-label'});
        this._panel.add_child(this._diskIo);
        // azul = leitura, laranja = escrita
        this._diskSpark = new Sparkline(this._panel, [[0.38, 0.63, 0.92], [0.96, 0.47, 0]]);

        this._panel.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._procRows = [];
        for (let i = 0; i < TOP_PROCESSES; i++) {
            const row = new St.BoxLayout({x_expand: true});
            const name = new St.Label({style_class: 'mf-label', x_expand: true});
            const value = new St.Label({style_class: 'mf-value'});
            row.add_child(name);
            row.add_child(value);
            this._panel.add_child(row);
            this._procRows.push({name, value});
        }

        this._load = new St.Label({style_class: 'mf-label'});
        this._uptime = new St.Label({style_class: 'mf-label'});
        this._panel.add_child(this._load);
        this._panel.add_child(this._uptime);

        this._panel.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this._applyTheme(this._themeIndex + 1);
                this._saveConfig();
                return Clutter.EVENT_STOP;
            }
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(event);
            return Clutter.EVENT_STOP;
        });
    }

    _startDrag(event) {
        const [x, y] = event.get_coords();
        this._dragOffset = [x - this._panel.x, y - this._panel.y];
        this._dragging = true;
        this._motionId = global.stage.connect('captured-event', (stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = ev.get_coords();
                this._panel.set_position(
                    Math.round(mx - this._dragOffset[0]),
                    Math.round(my - this._dragOffset[1]));
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                this._endDrag();
                this._saveConfig();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _endDrag() {
        if (this._motionId) {
            global.stage.disconnect(this._motionId);
            this._motionId = null;
        }
        this._dragging = false;
    }

    _loadConfig() {
        let x = 40, y = 60, tema = null;
        try {
            const cfg = JSON.parse(readText(this._configPath));
            if (Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
                x = cfg.x;
                y = cfg.y;
            }
            tema = cfg.tema ?? null;
        } catch (e) {
            // sem configuração salva: usa os padrões
        }
        this._panel.set_position(x, y);
        this._themeIndex = Math.max(0, this._themes.findIndex(t => t.nome === tema));
        this._applyTheme(this._themeIndex);
    }

    _saveConfig() {
        try {
            const data = JSON.stringify({
                x: this._panel.x,
                y: this._panel.y,
                tema: this._themes[this._themeIndex]?.nome ?? null,
            });
            GLib.file_set_contents(this._configPath, data);
        } catch (e) {
            console.error(`monitores-flutuantes: falha ao salvar configuração: ${e}`);
        }
    }

    _refresh() {
        if (!this._panel)
            return;

        const now = GLib.DateTime.new_now_local();
        this._clock.text = now.format('%H:%M:%S');
        this._date.text = now.format('%A, %d de %B de %Y');

        this._updateCpu();
        this._updateMemory();
        this._updateDisk();
        this._updateNet();
        this._updateTemp();
        this._updateBattery();
        this._updateDiskIo();
        this._updateProcesses();

        const load = readText('/proc/loadavg').split(' ');
        this._load.text = `Carga: ${load.slice(0, 3).join('  ')}`;
        const up = parseFloat(readText('/proc/uptime').split(' ')[0]);
        this._uptime.text = `Uptime: ${formatDuration(up)}`;
    }

    _updateCpu() {
        const line = readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        const idle = line[3] + (line[4] || 0);
        const total = line.reduce((a, b) => a + b, 0);
        if (this._prevCpu) {
            const dTotal = total - this._prevCpu.total;
            const dIdle = idle - this._prevCpu.idle;
            const usage = dTotal > 0 ? 1 - dIdle / dTotal : 0;
            this._bars.cpu.update(usage, `${Math.round(usage * 100)}%`);
        }
        this._prevCpu = {idle, total};
    }

    _updateMemory() {
        const info = {};
        for (const l of readText('/proc/meminfo').split('\n')) {
            const m = l.match(/^(\w+):\s+(\d+)/);
            if (m)
                info[m[1]] = parseInt(m[2]) * 1024;
        }
        const used = info.MemTotal - info.MemAvailable;
        this._bars.mem.update(used / info.MemTotal, `${formatBytes(used)} / ${formatBytes(info.MemTotal)}`);
        const swapUsed = info.SwapTotal - info.SwapFree;
        this._bars.swap.update(info.SwapTotal ? swapUsed / info.SwapTotal : 0,
            info.SwapTotal ? `${formatBytes(swapUsed)} / ${formatBytes(info.SwapTotal)}` : 'desativado');
    }

    _updateDisk() {
        try {
            const fi = Gio.File.new_for_path('/').query_filesystem_info(
                `${Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE},${Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE}`, null);
            const size = fi.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE);
            const free = fi.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE);
            this._bars.disk.update((size - free) / size, `${formatBytes(size - free)} / ${formatBytes(size)}`);
        } catch (e) {
            this._bars.disk.update(0, 'n/d');
        }
    }

    _updateNet() {
        let rx = 0, tx = 0;
        for (const l of readText('/proc/net/dev').split('\n').slice(2)) {
            const [iface, rest] = l.split(':');
            if (!rest || iface.trim() === 'lo')
                continue;
            const f = rest.trim().split(/\s+/).map(Number);
            rx += f[0];
            tx += f[8];
        }
        const t = GLib.get_monotonic_time() / 1e6;
        if (this._prevNet) {
            const dt = t - this._prevNet.t || 1;
            const down = Math.max(0, (rx - this._prevNet.rx) / dt);
            const up = Math.max(0, (tx - this._prevNet.tx) / dt);
            this._net.text = `Rede: ↓ ${formatBytes(down)}/s   ↑ ${formatBytes(up)}/s`;
            this._netSpark.push(down, up);
        }
        this._prevNet = {rx, tx, t};
    }

    _updateTemp() {
        if (!this._bars.temp)
            return;
        const celsius = parseInt(readText(this._tempPath)) / 1000;
        if (Number.isFinite(celsius))
            this._bars.temp.update(celsius / 100, `${Math.round(celsius)}°C`);
    }

    _updateBattery() {
        if (!this._bars.battery)
            return;
        const capacity = parseInt(readText(`${this._batteryPath}/capacity`));
        const status = readText(`${this._batteryPath}/status`).trim();
        const labels = {Charging: 'carregando', Discharging: 'descarregando', Full: 'cheia'};
        this._bars.battery.update(capacity / 100, `${capacity}% · ${labels[status] ?? 'conectada'}`,
            {alert: status !== 'Charging' && status !== 'Full'});
    }

    _updateDiskIo() {
        let read = 0, written = 0;
        for (const l of readText('/proc/diskstats').split('\n')) {
            const f = l.trim().split(/\s+/);
            if (DISK_DEVICE.test(f[2] ?? '')) {
                read += Number(f[5]) * 512;
                written += Number(f[9]) * 512;
            }
        }
        const t = GLib.get_monotonic_time() / 1e6;
        if (this._prevDisk) {
            const dt = t - this._prevDisk.t || 1;
            const r = Math.max(0, (read - this._prevDisk.read) / dt);
            const w = Math.max(0, (written - this._prevDisk.written) / dt);
            this._diskIo.text = `Disco I/O: R ${formatBytes(r)}/s   W ${formatBytes(w)}/s`;
            this._diskSpark.push(r, w);
        }
        this._prevDisk = {read, written, t};
    }

    // Uso de CPU por processo = variação de utime+stime entre duas leituras.
    _updateProcesses() {
        const t = GLib.get_monotonic_time() / 1e6;
        const procs = new Map();
        try {
            const en = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const pid = info.get_name();
                if (!/^\d+$/.test(pid))
                    continue;
                const stat = readText(`/proc/${pid}/stat`);
                const end = stat.lastIndexOf(')');
                if (end < 0)
                    continue;
                const f = stat.slice(end + 2).split(' ');
                procs.set(pid, {
                    name: stat.slice(stat.indexOf('(') + 1, end),
                    ticks: Number(f[11]) + Number(f[12]),
                    rss: Number(f[21]) * PAGE_SIZE,
                });
            }
        } catch (e) {
            return;
        }

        if (this._prevProcs) {
            const dt = (t - this._prevProcs.t) || 1;
            const top = [...procs].map(([pid, p]) => {
                const before = this._prevProcs.ticks.get(pid);
                return {...p, cpu: before === undefined ? 0 : Math.max(0, p.ticks - before) / CLOCK_TICKS / dt};
            }).sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, TOP_PROCESSES);
            this._procRows.forEach((row, i) => {
                row.name.text = top[i]?.name ?? '';
                row.value.text = top[i] ? `${Math.round(top[i].cpu * 100)}%  ${formatBytes(top[i].rss)}` : '';
            });
        }
        this._prevProcs = {t, ticks: new Map([...procs].map(([pid, p]) => [pid, p.ticks]))};
    }
}
