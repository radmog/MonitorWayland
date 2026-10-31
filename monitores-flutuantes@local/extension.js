import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_SECONDS = 1;
const DECODER = new TextDecoder();

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
    constructor(parent, label, {history = false} = {}) {
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

        this._spark = history ? new Sparkline(parent, [[0.38, 0.63, 0.92]], {max: 1}) : null;
    }

    update(fraction, text) {
        fraction = Math.max(0, Math.min(1, fraction));
        this._spark?.push(fraction);
        this._value.text = text;
        const width = this._bg.width;
        this._fill.width = Math.round(width * fraction);
        this._fill.style_class = 'mf-bar-fill' + (fraction > 0.9 ? ' crit' : fraction > 0.75 ? ' warn' : '');
    }
}

export default class MonitoresFlutuantes extends Extension {
    enable() {
        this._configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'monitores-flutuantes.json']);
        this._prevCpu = null;
        this._prevNet = null;
        this._dragging = false;

        this._buildPanel();
        this._loadPosition();
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
        this._panel?.destroy();
        this._panel = null;
        this._bars = null;
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

        this._panel.add_child(new St.Widget({style_class: 'mf-sep', x_expand: true}));
        this._net = new St.Label({style_class: 'mf-label'});
        this._panel.add_child(this._net);
        // verde = download, laranja = upload
        this._netSpark = new Sparkline(this._panel, [[0.34, 0.8, 0.52], [0.96, 0.47, 0]]);
        this._load = new St.Label({style_class: 'mf-label'});
        this._uptime = new St.Label({style_class: 'mf-label'});
        this._panel.add_child(this._load);
        this._panel.add_child(this._uptime);

        this._panel.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
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
                this._savePosition();
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

    _loadPosition() {
        let x = 40, y = 60;
        try {
            const pos = JSON.parse(readText(this._configPath));
            if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                x = pos.x;
                y = pos.y;
            }
        } catch (e) {
            // sem configuração salva: usa a posição padrão
        }
        this._panel.set_position(x, y);
    }

    _savePosition() {
        try {
            const data = JSON.stringify({x: this._panel.x, y: this._panel.y});
            GLib.file_set_contents(this._configPath, data);
        } catch (e) {
            console.error(`monitores-flutuantes: falha ao salvar posição: ${e}`);
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
}
