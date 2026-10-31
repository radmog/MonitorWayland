import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_SECONDS = 1;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MARGIN = 40;
const PANEL_BG_DEFAULT = 'rgba(15, 17, 22, 0.62)';
const DECODER = new TextDecoder();
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'];
const TOP_PROCESSES = 4;
const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;
const UPCOMING_EVENTS = 3;
const EVENTS_WINDOW_DAYS = 14;
const TAILSCALE_IFACE = 'tailscale0';
const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

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

// Uma coluna por núcleo, altura proporcional ao uso.
class CoreBars {
    constructor(parent) {
        this._usage = [];
        this.actor = new St.DrawingArea({style_class: 'mf-spark', x_expand: true, height: 22});
        this.actor.connect('repaint', area => this._draw(area));
        parent.add_child(this.actor);
    }

    set(usage) {
        this._usage = usage;
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const n = this._usage.length;
        if (n) {
            const gap = 3;
            const bw = (w - gap * (n - 1)) / n;
            this._usage.forEach((u, i) => {
                const x = i * (bw + gap);
                cr.setSourceRGBA(1, 1, 1, 0.12);
                cr.rectangle(x, 0, bw, h);
                cr.fill();
                const [r, g, b] = u > 0.9 ? [0.93, 0.2, 0.23] : u > 0.75 ? [0.96, 0.76, 0.07] : [0.38, 0.63, 0.92];
                cr.setSourceRGBA(r, g, b, 1);
                cr.rectangle(x, h - u * h, bw, u * h);
                cr.fill();
            });
        }
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
        this._prevProcs = null;
        this._cancellable = new Gio.Cancellable();
        this._calendarDay = null;
        this._tempPath = findCpuTempPath();
        this._batteryPath = findBatteryPath();
        this._dragging = false;
        this._bgSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._bgOriginal = {
            light: this._bgSettings.get_string('picture-uri'),
            dark: this._bgSettings.get_string('picture-uri-dark'),
        };

        this._buildPanels();
        this._themes = this._loadThemes();
        Main.layoutManager._backgroundGroup.add_child(this._left);
        Main.layoutManager._backgroundGroup.add_child(this._right);
        this._loadConfig();

        this._startNetworkManager();
        this._startEventSource();

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
        this._cancellable?.cancel();
        this._cancellable = null;
        this._nm = null;
        if (this._eventSource) {
            this._eventSource.disconnect(this._eventsChangedId);
            this._eventSource.destroy();
            this._eventSource = null;
        }
        if (this._bgSettings) {
            this._bgSettings.set_string('picture-uri', this._bgOriginal.light);
            this._bgSettings.set_string('picture-uri-dark', this._bgOriginal.dark);
        }
        this._bgSettings = null;
        this._themes = null;
        this._left?.destroy();
        this._right?.destroy();
        this._left = null;
        this._right = null;
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
        for (const panel of [this._left, this._right])
            panel.set_style(`background-color: ${theme.painel};`);
    }

    _makePanel() {
        const panel = new St.BoxLayout({
            style_class: 'mf-panel',
            vertical: true,
            reactive: true,
            track_hover: true,
        });
        panel.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this._applyTheme(this._themeIndex + 1);
                this._saveConfig();
                return Clutter.EVENT_STOP;
            }
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(panel, event);
            return Clutter.EVENT_STOP;
        });
        return panel;
    }

    // esquerda: hardware, processos e rede; direita: agenda
    _buildPanels() {
        let col = this._left = this._makePanel();

        this._clock = new St.Label({style_class: 'mf-clock'});
        this._date = new St.Label({style_class: 'mf-date'});
        col.add_child(this._clock);
        col.add_child(this._date);
        col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));

        this._bars = {cpu: new Bar(col, 'CPU', {history: true})};
        this._coreBars = new CoreBars(col);
        this._freq = new St.Label({style_class: 'mf-label'});
        col.add_child(this._freq);
        col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._procRows = [];
        for (let i = 0; i < TOP_PROCESSES; i++) {
            const row = new St.BoxLayout({x_expand: true});
            const name = new St.Label({style_class: 'mf-label', x_expand: true});
            const value = new St.Label({style_class: 'mf-value'});
            row.add_child(name);
            row.add_child(value);
            col.add_child(row);
            this._procRows.push({name, value});
        }

        col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._bars.mem = new Bar(col, 'Memória', {history: true});
        this._bars.disk = new Bar(col, 'Disco /');
        if (this._tempPath)
            this._bars.temp = new Bar(col, 'Temperatura', {history: true, historyMax: 1});
        if (this._batteryPath)
            this._bars.battery = new Bar(col, 'Bateria', {invert: true});
        col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._net = new St.Label({style_class: 'mf-label'});
        col.add_child(this._net);
        // verde = download, laranja = upload
        this._netSpark = new Sparkline(col, [[0.34, 0.8, 0.52], [0.96, 0.47, 0]]);
        this._ip = new St.Label({style_class: 'mf-label'});
        this._tailscale = new St.Label({style_class: 'mf-label'});
        col.add_child(this._ip);
        col.add_child(this._tailscale);

        col = this._right = this._makePanel();
        this._calTitle = new St.Label({style_class: 'mf-value'});
        this._calGrid = new St.BoxLayout({vertical: true, x_expand: true});
        col.add_child(this._calTitle);
        col.add_child(this._calGrid);
        this._eventRows = [];
        for (let i = 0; i < UPCOMING_EVENTS; i++) {
            const label = new St.Label({style_class: 'mf-label'});
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            col.add_child(label);
            this._eventRows.push(label);
        }
    }

    _startDrag(panel, event) {
        const [x, y] = event.get_coords();
        this._dragOffset = [x - panel.x, y - panel.y];
        this._dragging = true;
        this._motionId = global.stage.connect('captured-event', (stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [mx, my] = ev.get_coords();
                panel.set_position(
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

    // Padrão: um painel em cada lado do monitor primário.
    _loadConfig() {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, rightWidth] = this._right.get_preferred_width(-1);
        const pos = {
            left: [monitor.x + MARGIN, monitor.y + 60],
            right: [monitor.x + monitor.width - rightWidth - MARGIN, monitor.y + 60],
        };
        let tema = null;
        try {
            const cfg = JSON.parse(readText(this._configPath));
            for (const side of ['left', 'right']) {
                if (Number.isFinite(cfg[side]?.x) && Number.isFinite(cfg[side]?.y))
                    pos[side] = [cfg[side].x, cfg[side].y];
            }
            tema = cfg.tema ?? null;
        } catch (e) {
            // sem configuração salva: usa os padrões
        }
        this._left.set_position(...pos.left);
        this._right.set_position(...pos.right);
        this._themeIndex = Math.max(0, this._themes.findIndex(t => t.nome === tema));
        this._applyTheme(this._themeIndex);
    }

    _saveConfig() {
        try {
            const data = JSON.stringify({
                left: {x: this._left.x, y: this._left.y},
                right: {x: this._right.x, y: this._right.y},
                tema: this._themes[this._themeIndex]?.nome ?? null,
            });
            GLib.file_set_contents(this._configPath, data);
        } catch (e) {
            console.error(`monitores-flutuantes: falha ao salvar configuração: ${e}`);
        }
    }

    _refresh() {
        if (!this._left)
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
        this._updateProcesses();
        this._updateNetworkInfo();
        this._updateCalendar();
    }

    _updateCpu() {
        const stats = [];
        for (const l of readText('/proc/stat').split('\n')) {
            if (!/^cpu\d*\s/.test(l))
                continue;
            const f = l.trim().split(/\s+/).slice(1).map(Number);
            stats.push({idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0)});
        }
        if (this._prevCpu?.length === stats.length) {
            const usage = stats.map((st, i) => {
                const dTotal = st.total - this._prevCpu[i].total;
                return dTotal > 0 ? 1 - (st.idle - this._prevCpu[i].idle) / dTotal : 0;
            });
            this._bars.cpu.update(usage[0], `${Math.round(usage[0] * 100)}%`);
            this._coreBars.set(usage.slice(1));
        }
        this._prevCpu = stats;

        const freqs = [];
        for (let i = 0; i < stats.length - 1; i++) {
            const khz = parseInt(readText(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`));
            if (Number.isFinite(khz))
                freqs.push(khz / 1e6);
        }
        if (freqs.length) {
            const avg = freqs.reduce((a, b) => a + b, 0) / freqs.length;
            this._freq.text = `Freq: ${avg.toFixed(2)} GHz  (máx ${Math.max(...freqs).toFixed(2)})`;
        }
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

    _startNetworkManager() {
        this._nm = null;
        NM.Client.new_async(this._cancellable, (obj, res) => {
            try {
                this._nm = NM.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`monitores-flutuantes: falha ao conectar ao NetworkManager: ${e}`);
            }
        });
    }

    _ip4Address(device) {
        return device?.get_ip4_config()?.get_addresses()[0]?.get_address() ?? null;
    }

    // Tailscale sempre aparece: sem a interface ou sem IP, mostra "desconectado".
    _updateNetworkInfo() {
        let ip = 'sem conexão', tailscale = 'desconectado';
        if (this._nm) {
            const device = this._nm.get_primary_connection()?.get_devices()[0];
            const addr = this._ip4Address(device);
            if (addr) {
                let name = device.get_iface();
                if (device.get_device_type() === NM.DeviceType.WIFI) {
                    const ssid = device.get_active_access_point()?.get_ssid();
                    name = ssid ? NM.utils_ssid_to_utf8(ssid.toArray()) : 'Wi-Fi';
                } else if (device.get_device_type() === NM.DeviceType.ETHERNET) {
                    name = 'Cabo';
                }
                ip = `${name} · ${addr}`;
            }
            const ts = this._ip4Address(this._nm.get_device_by_iface(TAILSCALE_IFACE));
            if (ts)
                tailscale = ts;
        } else {
            ip = 'NetworkManager indisponível';
        }
        this._ip.text = `IP: ${ip}`;
        this._tailscale.text = `Tailscale: ${tailscale}`;
    }

    _startEventSource() {
        this._eventSource = new Calendar.DBusEventSource();
        this._eventsChangedId = this._eventSource.connect('changed', () => this._updateEvents());
    }

    _updateCalendar() {
        const now = GLib.DateTime.new_now_local();
        const day = now.format('%Y-%m-%d');
        if (day !== this._calendarDay) {
            this._calendarDay = day;
            this._buildMonth(now);
            const begin = new Date();
            begin.setHours(0, 0, 0, 0);
            const end = new Date(begin.getTime() + EVENTS_WINDOW_DAYS * 86400000);
            this._eventSource.requestRange(begin, end);
        }
        this._updateEvents();
    }

    _buildMonth(now) {
        this._calTitle.text = now.format('%B %Y');
        this._calGrid.destroy_all_children();

        const cell = (text, style = '') => new St.Label({text, style_class: `mf-cal-day ${style}`, x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        WEEKDAYS.forEach(d => header.add_child(cell(d, 'mf-cal-head')));
        this._calGrid.add_child(header);

        const year = now.get_year(), month = now.get_month();
        const offset = GLib.DateTime.new_local(year, month, 1, 0, 0, 0).get_day_of_week() % 7;
        const total = GLib.Date.get_days_in_month(month, year);
        let row = null;
        for (let i = 0; i < Math.ceil((offset + total) / 7) * 7; i++) {
            if (i % 7 === 0) {
                row = new St.BoxLayout({x_expand: true});
                this._calGrid.add_child(row);
            }
            const d = i - offset + 1;
            row.add_child(d < 1 || d > total
                ? cell('')
                : cell(`${d}`, d === now.get_day_of_month() ? 'mf-cal-today' : ''));
        }
    }

    _updateEvents() {
        const now = new Date();
        const end = new Date(now.getTime() + EVENTS_WINDOW_DAYS * 86400000);
        const events = this._eventSource.getEvents(now, end)
            .filter(e => e.end > now).slice(0, UPCOMING_EVENTS);
        this._eventRows.forEach((label, i) => {
            const e = events[i];
            if (!e) {
                label.text = i === 0 ? 'Sem eventos próximos' : '';
                return;
            }
            const when = GLib.DateTime.new_from_unix_local(Math.floor(e.date.getTime() / 1000));
            const allDay = e.date.getHours() === 0 && e.date.getMinutes() === 0 &&
                (e.end - e.date) % 86400000 === 0;
            label.text = `${when.format(allDay ? '%d/%m' : '%d/%m %H:%M')}  ${e.summary}`;
        });
    }
}
