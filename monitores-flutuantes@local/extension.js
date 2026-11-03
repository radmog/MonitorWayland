import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import NM from 'gi://NM';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_SECONDS = 1;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MARGIN = 40;
const MIN_VISIVEL = 100;
const PANEL_BG_DEFAULT = 'rgba(15, 17, 22, 0.62)';
const DECODER = new TextDecoder();
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'];
const UPCOMING_EVENTS = 3;
const EVENTS_WINDOW_DAYS = 14;
const TAILSCALE_IFACE = 'tailscale0';
const PUBLIC_IP_URL = 'https://api.ipify.org';
const PUBLIC_IP_REFRESH_SECONDS = 600;
const PUBLIC_IP_RETRY_SECONDS = 30;
const WEATHER_REFRESH_SECONDS = 1800;
const WEATHER_RETRY_SECONDS = 60;
const FORECAST_DAYS = 5;
const DEFAULT_WEATHER = {cidade: 'Manaus - AM', lat: -3.119, lon: -60.0217};
const EVENT_COLORS = {allDay: '#ed333b', timed: '#f5c211'};
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
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// Código WMO (Open-Meteo) -> [emoji, descrição]
function weatherInfo(code) {
    if (code === 0) return ['☀️', 'Céu limpo'];
    if (code === 1) return ['🌤️', 'Predominantemente limpo'];
    if (code === 2) return ['⛅', 'Parcialmente nublado'];
    if (code === 3) return ['☁️', 'Nublado'];
    if (code === 45 || code === 48) return ['🌫️', 'Neblina'];
    if (code >= 51 && code <= 57) return ['🌦️', 'Garoa'];
    if (code >= 61 && code <= 67) return ['🌧️', 'Chuva'];
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['🌨️', 'Neve'];
    if (code >= 80 && code <= 82) return ['🌦️', 'Pancadas de chuva'];
    if (code >= 95) return ['⛈️', 'Tempestade'];
    return ['🌡️', 'Indefinido'];
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
    constructor(parent, icons, icon, label, kind, {history = false, invert = false} = {}) {
        this._kind = kind;
        this._invert = invert;
        const row = new St.BoxLayout({x_expand: true, style_class: 'mf-row'});
        row.add_child(makeIcon(icons, icon));
        const body = new St.BoxLayout({vertical: true, x_expand: true});
        const head = new St.BoxLayout({x_expand: true});
        this._label = new St.Label({text: label, style_class: 'mf-label', x_expand: true});
        this._value = new St.Label({text: '-', style_class: 'mf-value'});
        head.add_child(this._label);
        head.add_child(this._value);
        body.add_child(head);

        this._bg = new St.Widget({style_class: 'mf-bar-bg', x_expand: true, layout_manager: new Clutter.BinLayout()});
        this._fill = new St.Widget({style_class: `mf-bar-fill mf-${kind}`, x_align: Clutter.ActorAlign.START});
        this._bg.add_child(this._fill);
        body.add_child(this._bg);
        this._spark = history ? new Sparkline(body, [[0.38, 0.63, 0.92]], {max: 1}) : null;
        row.add_child(body);
        parent.add_child(row);
    }

    // `invert`: valores baixos são o estado ruim (ex.: bateria).
    update(fraction, text, {alert = true} = {}) {
        fraction = Math.max(0, Math.min(1, fraction));
        this._spark?.push(fraction);
        this._value.text = text;
        this._fill.width = Math.round(this._bg.width * fraction);
        const level = this._invert ? 1 - fraction : fraction;
        const state = !alert ? '' : level > 0.9 ? ' crit' : level > 0.75 ? ' warn' : '';
        this._fill.style_class = `mf-bar-fill mf-${this._kind}${state}`;
    }
}

function makeIcon(icons, name) {
    return new St.Icon({
        gicon: new Gio.FileIcon({file: icons.get_child(`${name}.svg`)}),
        icon_size: 20,
        style_class: 'mf-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export default class MonitoresFlutuantes extends Extension {
    enable() {
        this._configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'monitores-flutuantes.json']);
        this._prevCpu = null;
        this._prevNet = null;
        this._cancellable = new Gio.Cancellable();
        this._calendarDay = null;
        this._polls = new Map();
        this._weather = {...DEFAULT_WEATHER};
        this._icons = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'icons']));
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
        // O DING cobre o fundo com uma janela DESKTOP e engole os cliques: o painel
        // fica no window_group, logo acima das janelas de desktop e abaixo das demais.
        global.window_group.add_child(this._left);
        this._restackedId = global.display.connect('restacked', () => this._lowerPanel());
        this._lowerPanel();
        this._loadConfig();
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._placePanel());

        this._startNetworkManager();
        this._soup = new Soup.Session({timeout: 10});
        this._poll('publicIp', PUBLIC_IP_URL, text => this._parsePublicIp(text),
            PUBLIC_IP_REFRESH_SECONDS, PUBLIC_IP_RETRY_SECONDS);
        this._poll('weather', this._weatherUrl(), text => this._parseWeather(text),
            WEATHER_REFRESH_SECONDS, WEATHER_RETRY_SECONDS);
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
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = null;
        }
        this._endDrag();
        this._cancellable?.cancel();
        this._cancellable = null;
        this._polls?.forEach(id => id && GLib.Source.remove(id));
        this._polls = null;
        this._soup?.abort();
        this._soup = null;
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
        this._left = null;
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
        this._left.set_style(`background-color: ${theme.painel};`);
    }

    _lowerPanel() {
        let ref = null;
        for (const actor of global.window_group.get_children()) {
            if (actor !== this._left && actor.meta_window?.get_window_type() === Meta.WindowType.DESKTOP)
                ref = actor;
        }
        if (ref)
            global.window_group.set_child_above_sibling(this._left, ref);
        else
            global.window_group.set_child_below_sibling(this._left, null);
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

    // hardware, rede, clima e agenda
    _buildPanels() {
        const col = this._left = this._makePanel();
        const sep = () => col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        const icons = this._icons;

        this._clock = new St.Label({style_class: 'mf-clock'});
        this._date = new St.Label({style_class: 'mf-date'});
        col.add_child(this._clock);
        col.add_child(this._date);

        this._bars = {
            cpu: new Bar(col, icons, 'cpu', 'CPU', 'cpu', {history: true}),
        };
        this._coreBars = new CoreBars(col);
        this._freq = new St.Label({style_class: 'mf-label'});
        col.add_child(this._freq);
        sep();
        this._bars.mem = new Bar(col, icons, 'memory', 'Memória', 'mem', {history: true});
        this._bars.disk = new Bar(col, icons, 'disk', 'Disco /', 'disk');
        if (this._tempPath)
            this._bars.temp = new Bar(col, icons, 'temp', 'Temperatura', 'temp', {history: true});
        if (this._batteryPath)
            this._bars.battery = new Bar(col, icons, 'battery', 'Bateria', 'battery', {invert: true});

        const net = new St.BoxLayout({x_expand: true, style_class: 'mf-row'});
        net.add_child(makeIcon(icons, 'network'));
        net.add_child(new St.Label({text: 'Rede', style_class: 'mf-label', x_expand: true}));
        this._up = new St.Label({style_class: 'mf-value mf-up'});
        this._down = new St.Label({style_class: 'mf-value mf-down'});
        net.add_child(this._up);
        net.add_child(this._down);
        col.add_child(net);
        // verde = download, laranja = upload
        this._netSpark = new Sparkline(col, [[0.34, 0.8, 0.52], [0.96, 0.47, 0]]);

        const wifi = new St.BoxLayout({x_expand: true, style_class: 'mf-row'});
        wifi.add_child(makeIcon(icons, 'wifi'));
        wifi.add_child(new St.Label({text: 'Wi-Fi', style_class: 'mf-label', x_expand: true}));
        this._ssid = new St.Label({style_class: 'mf-value'});
        wifi.add_child(this._ssid);
        col.add_child(wifi);
        this._ip = this._addDetail(col, 'IP:');
        this._publicIp = this._addDetail(col, 'Pública:');
        this._tailscale = this._addDetail(col, 'Tailscale:');

        sep();
        this._buildWeather(col);
        sep();
        this._calTitle = new St.Label({style_class: 'mf-value'});
        this._calGrid = new St.BoxLayout({vertical: true, x_expand: true});
        col.add_child(this._calTitle);
        col.add_child(this._calGrid);
        this._eventRows = [];
        for (let i = 0; i < UPCOMING_EVENTS; i++) {
            const row = new St.BoxLayout({x_expand: true});
            const dot = new St.Label({text: '●', style_class: 'mf-dot'});
            const label = new St.Label({style_class: 'mf-label', x_expand: true});
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            row.add_child(dot);
            row.add_child(label);
            col.add_child(row);
            this._eventRows.push({row, dot, label});
        }
    }

    _addDetail(parent, key) {
        const row = new St.BoxLayout({x_expand: true, style_class: 'mf-detail'});
        row.add_child(new St.Label({text: key, style_class: 'mf-label', x_expand: true}));
        const value = new St.Label({style_class: 'mf-value'});
        row.add_child(value);
        parent.add_child(row);
        return value;
    }

    _buildWeather(col) {
        const now = new St.BoxLayout({x_expand: true});
        this._wIcon = new St.Label({style_class: 'mf-wicon'});
        const info = new St.BoxLayout({vertical: true, x_expand: true});
        this._wCity = new St.Label({style_class: 'mf-wcity'});
        this._wTemp = new St.Label({style_class: 'mf-wtemp'});
        this._wDesc = new St.Label({style_class: 'mf-wdesc'});
        this._wRange = new St.Label({style_class: 'mf-date'});
        [this._wCity, this._wTemp, this._wDesc, this._wRange].forEach(l => info.add_child(l));
        now.add_child(this._wIcon);
        now.add_child(info);
        col.add_child(now);

        col.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._forecast = new St.BoxLayout({x_expand: true});
        this._forecastCols = [];
        for (let i = 0; i < FORECAST_DAYS; i++) {
            const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mf-fday'});
            const labels = ['mf-cal-head', 'mf-wsmall', 'mf-value', 'mf-label'].map(c => {
                const l = new St.Label({style_class: `mf-fcell ${c}`, x_align: Clutter.ActorAlign.CENTER});
                box.add_child(l);
                return l;
            });
            this._forecast.add_child(box);
            this._forecastCols.push(labels);
        }
        col.add_child(this._forecast);
        this._wCity.text = this._weather.cidade;
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

    _loadConfig() {
        let tema = null;
        try {
            const cfg = JSON.parse(readText(this._configPath));
            if (Number.isFinite(cfg.left?.x) && Number.isFinite(cfg.left?.y))
                this._savedPos = [cfg.left.x, cfg.left.y];
            tema = cfg.tema ?? null;
            if (Number.isFinite(cfg.clima?.lat) && Number.isFinite(cfg.clima?.lon))
                this._weather = {...DEFAULT_WEATHER, ...cfg.clima};
        } catch (e) {
            // sem configuração salva: usa os padrões
        }
        this._placePanel();
        this._themeIndex = Math.max(0, this._themes.findIndex(t => t.nome === tema));
        this._applyTheme(this._themeIndex);
        this._wCity.text = this._weather.cidade;
    }

    // A posição salva pode cair fora das telas atuais (ex.: segundo monitor desconectado).
    // O ajuste não é gravado, então ao religar o monitor a posição original volta.
    _placePanel() {
        const monitors = Main.layoutManager.monitors;
        const primary = Main.layoutManager.primaryMonitor;
        let [x, y] = this._savedPos ?? [primary.x + MARGIN, primary.y + 60];
        const visible = monitors.find(m =>
            x >= m.x && x <= m.x + m.width - MIN_VISIVEL &&
            y >= m.y && y <= m.y + m.height - MIN_VISIVEL);
        if (!visible)
            [x, y] = [primary.x + MARGIN, primary.y + 60];
        this._left.set_position(x, y);
    }

    _saveConfig() {
        try {
            this._savedPos = [this._left.x, this._left.y];
            const data = JSON.stringify({
                left: {x: this._left.x, y: this._left.y},
                tema: this._themes[this._themeIndex]?.nome ?? null,
                clima: this._weather,
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
        this._date.text = capitalize(now.format('%A').replace('-feira', '')) + now.format(', %-d de %B de %Y');

        this._updateCpu();
        this._updateMemory();
        this._updateDisk();
        this._updateNet();
        this._updateTemp();
        this._updateBattery();
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
            this._up.text = `↑ ${formatBytes(up)}/s`;
            this._down.text = `↓ ${formatBytes(down)}/s`;
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
        this._bars.battery.update(capacity / 100, `${capacity}% • ${labels[status] ?? 'conectada'}`,
            {alert: status !== 'Charging' && status !== 'Full'});
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

    // GET periódico: `parse` devolve true se o texto foi aceito; falhas repetem após `retry` segundos.
    _poll(name, url, parse, refresh, retry) {
        const msg = Soup.Message.new('GET', url);
        this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (session, res) => {
            let ok = false;
            try {
                const bytes = session.send_and_read_finish(res);
                ok = msg.get_status() === Soup.Status.OK && parse(DECODER.decode(bytes.get_data()).trim());
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            if (!ok)
                parse(null);
            this._polls.set(name, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ok ? refresh : retry, () => {
                this._polls.set(name, null);
                this._poll(name, url, parse, refresh, retry);
                return GLib.SOURCE_REMOVE;
            }));
        });
    }

    _parsePublicIp(text) {
        const ok = text !== null && /^[0-9a-fA-F.:]+$/.test(text);
        this._publicIp.text = ok ? text : 'indisponível';
        return ok;
    }

    _weatherUrl() {
        const {lat, lon} = this._weather;
        return 'https://api.open-meteo.com/v1/forecast?' +
            `latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${FORECAST_DAYS + 1}`;
    }

    _parseWeather(text) {
        if (text === null)
            return false;
        try {
            const data = JSON.parse(text);
            const [icon, desc] = weatherInfo(data.current.weather_code);
            const d = data.daily;
            this._wIcon.text = icon;
            this._wTemp.text = `${Math.round(data.current.temperature_2m)}°C`;
            this._wDesc.text = desc;
            this._wRange.text = `Máx: ${Math.round(d.temperature_2m_max[0])}°C  Min: ${Math.round(d.temperature_2m_min[0])}°C`;
            this._forecastCols.forEach((cells, i) => {
                const [y, m, day] = d.time[i + 1].split('-').map(Number);
                const date = GLib.DateTime.new_local(y, m, day, 0, 0, 0);
                cells[0].text = capitalize(date.format('%a').replace('.', ''));
                cells[1].text = weatherInfo(d.weather_code[i + 1])[0];
                cells[2].text = `${Math.round(d.temperature_2m_max[i + 1])}°`;
                cells[3].text = `${Math.round(d.temperature_2m_min[i + 1])}°`;
            });
            return true;
        } catch (e) {
            console.error(`monitores-flutuantes: resposta de clima inválida: ${e}`);
            return false;
        }
    }

    _ip4Address(device) {
        return device?.get_ip4_config()?.get_addresses()[0]?.get_address() ?? null;
    }

    _updateNetworkInfo() {
        let ssid = 'sem conexão', ip = '-', tailscale = 'desconectado';
        if (this._nm) {
            const device = this._nm.get_primary_connection()?.get_devices()[0];
            const addr = this._ip4Address(device);
            if (addr) {
                ip = addr;
                ssid = device.get_iface();
                if (device.get_device_type() === NM.DeviceType.WIFI) {
                    const ap = device.get_active_access_point()?.get_ssid();
                    ssid = ap ? NM.utils_ssid_to_utf8(ap.toArray()) : 'Wi-Fi';
                } else if (device.get_device_type() === NM.DeviceType.ETHERNET) {
                    ssid = 'Cabo';
                }
            }
            tailscale = this._ip4Address(this._nm.get_device_by_iface(TAILSCALE_IFACE)) ?? tailscale;
        } else {
            ssid = 'NM indisponível';
        }
        this._ssid.text = ssid;
        this._ip.text = ip;
        this._tailscale.text = tailscale;
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
        this._calTitle.text = capitalize(now.format('%B %Y'));
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
        this._eventRows.forEach(({row, dot, label}, i) => {
            const e = events[i];
            row.visible = i === 0 || !!e;
            dot.visible = !!e;
            if (!e) {
                label.text = i === 0 ? 'Sem eventos próximos' : '';
                return;
            }
            const when = GLib.DateTime.new_from_unix_local(Math.floor(e.date.getTime() / 1000));
            const allDay = e.date.getHours() === 0 && e.date.getMinutes() === 0 &&
                (e.end - e.date) % 86400000 === 0;
            dot.set_style(`color: ${allDay ? EVENT_COLORS.allDay : EVENT_COLORS.timed};`);
            label.text = allDay ? `${when.format('%d/%m')}  ${e.summary}` : `${when.format('%d/%m %H:%M')} - ${e.summary}`;
        });
    }
}
