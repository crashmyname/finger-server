require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3011;

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finger_db',
    waitForConnections: true,
    connectionLimit: 10,
});

app.use(express.text({ type: 'text/plain', limit: '10mb' }));

app.get('/iclock/cdata', (req, res) => {
    const sn = req.query.SN || 'UNKNOWN';
    res.type('text/plain').send(
        `GET OPTION FROM: ${sn}\n` +
        `Stamp=9999\nOpStamp=9999\n` +
        `ErrorDelay=30\nDelay=10\n` +
        `TransTimes=00:00;14:05\nTransInterval=1\n` +
        `TransFlag=1111000000\nRealtime=1\nEncrypt=0\n`
    );
});

function parseAttendanceLine(line, sn) {
    const cols = line.split('\t');
    if (cols.length < 4) return null;
    if (!cols[1].match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) return null;
    const status = parseInt(cols[2], 10);
    const verifyMode = parseInt(cols[3], 10);
    if (isNaN(status) || isNaN(verifyMode)) return null;
    return {
        sn,
        pin: cols[0].trim(),
        punchTime: cols[1].trim(),
        status,
        verifyMode,
        workCode: cols[4] ? parseInt(cols[4], 10) : 0,
        raw: line,
    };
}

function parseFpLine(line, sn) {
    const content = line.replace(/^FP\s+/, '');
    const fields = {};
    for (const part of content.split('\t')) {
        const eq = part.indexOf('=');
        if (eq > 0) fields[part.substring(0, eq)] = part.substring(eq + 1);
    }
    if (!fields.TMP || !fields.PIN) return null;
    const buf = Buffer.from(fields.TMP, 'base64');
    return {
        sn,
        pin: fields.PIN,
        fid: parseInt(fields.FID || '0', 10),
        size: parseInt(fields.Size || buf.length, 10),
        valid: fields.Valid === '1' ? 1 : 0,
        templateData: buf,
        raw: line,
    };
}

function parseOpLogLine(line, sn) {
    const content = line.replace(/^OPLOG\s+/, '');
    if (content.includes('PIN=')) {
        const fields = {};
        for (const part of content.split('\t')) {
            const eq = part.indexOf('=');
            if (eq > 0) fields[part.substring(0, eq)] = part.substring(eq + 1);
        }
        return {
            sn,
            pin: fields.PIN || null,
            oplogTime: fields.DateTime || null,
            opType: parseInt(fields.OpType || '0', 10),
            opWho: fields.OpWho ? parseInt(fields.OpWho, 10) : null,
            subType: fields.SubType ? parseInt(fields.SubType, 10) : null,
            raw: line,
        };
    }
    const cols = content.split('\t');
    if (cols.length < 4) return null;
    return {
        sn,
        pin: cols[0].trim() || null,
        oplogTime: cols[1].trim(),
        opType: parseInt(cols[2], 10),
        opWho: parseInt(cols[3], 10),
        subType: cols[4] ? parseInt(cols[4], 10) : null,
        raw: line,
    };
}

app.post('/iclock/cdata', async (req, res) => {
    const table = (req.query.table || '').toUpperCase();
    const sn = req.query.SN || 'UNKNOWN';
    const body = (req.body || '').trim();
    res.type('text/plain').send('OK');

    if (!body) return;

    const lines = body.split(/\r?\n/).filter(Boolean);

    const attendances = [];
    const fps = [];
    const oplogs = [];

    for (const line of lines) {
        if (line.startsWith('FP ')) {
            const p = parseFpLine(line, sn);
            if (p) fps.push(p);
        } else if (line.startsWith('OPLOG ')) {
            const p = parseOpLogLine(line, sn);
            if (p) oplogs.push(p);
        } else if (/^\d/.test(line)) {
            const p = parseAttendanceLine(line, sn);
            if (p) attendances.push(p);
        }
    }

    if (attendances.length) {
        const rows = attendances.map(a => [
            a.sn, a.pin, a.punchTime, a.status, a.verifyMode, a.workCode, a.raw
        ]);
        try {
            const [r] = await pool.query(
                `INSERT INTO attendance_logs
                 (device_sn, pin, punch_time, status, verify_mode, work_code, raw_line)
                 VALUES ?`,
                [rows]
            );
            console.log(`ATTLOG: ${r.affectedRows} baris dari ${sn}`);
        } catch (e) {
            console.error('ATTLOG insert error:', e.message);
        }
    }

    if (fps.length) {
        try {
            for (const f of fps) {
                await pool.query(
                    `INSERT INTO fingerprint_templates
                     (device_sn, pin, fid, size, valid, template_data, raw_line)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        size = VALUES(size),
                        valid = VALUES(valid),
                        template_data = VALUES(template_data),
                        raw_line = VALUES(raw_line)`,
                    [f.sn, f.pin, f.fid, f.size, f.valid, f.templateData, f.raw]
                );
            }
            console.log(`FP: ${fps.length} template dari ${sn}`);
        } catch (e) {
            console.error('FP upsert error:', e.message);
        }
    }

    if (oplogs.length) {
        const rows = oplogs.map(o => [
            o.sn, o.pin, o.oplogTime, o.opType, o.opWho, o.subType, o.raw
        ]);
        try {
            const [r] = await pool.query(
                `INSERT INTO operation_logs
                 (device_sn, pin, oplog_time, op_type, op_who, sub_type, raw_line)
                 VALUES ?`,
                [rows]
            );
            console.log(`OPLOG: ${r.affectedRows} baris dari ${sn}`);
        } catch (e) {
            console.error('OPLOG insert error:', e.message);
        }
    }
});

app.get('/iclock/getrequest', (req, res) => {
    res.type('text/plain').send('OK');
});

// =====================================================
// ROUTE API UNTUK LIHAT DATA
// =====================================================

const int = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
};

app.get('/api/stats', async (req, res) => {
    try {
        const [[a]] = await pool.query('SELECT COUNT(*) AS total, MAX(punch_time) AS terakhir FROM attendance_logs');
        const [[f]] = await pool.query('SELECT COUNT(*) AS total FROM fingerprint_templates');
        const [[o]] = await pool.query('SELECT COUNT(*) AS total FROM operation_logs');
        const [[d]] = await pool.query('SELECT COUNT(DISTINCT device_sn) AS total FROM attendance_logs');
        const [[today]] = await pool.query(
            'SELECT COUNT(*) AS total FROM attendance_logs WHERE DATE(punch_time) = CURDATE()'
        );
        res.json({
            attendance: { total: a.total, terakhir: a.terakhir, hari_ini: today.total },
            fingerprint: { total: f.total },
            oplog: { total: o.total },
            devices: { total: d.total },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/attendance', async (req, res) => {
    const { date, pin, device_sn } = req.query;
    const limit  = Math.min(int(req.query.limit, 100), 1000);
    const offset = int(req.query.offset, 0);

    const where = [];
    const params = [];

    if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Format date harus YYYY-MM-DD' });
        }
        where.push('DATE(punch_time) = ?');
        params.push(date);
    }
    if (pin)       { where.push('pin = ?');       params.push(pin); }
    if (device_sn) { where.push('device_sn = ?'); params.push(device_sn); }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    try {
        const [rows] = await pool.query(
            `SELECT id, device_sn, pin, punch_time, status, verify_mode, work_code, created_at
             FROM attendance_logs
             ${whereSql}
             ORDER BY punch_time DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM attendance_logs ${whereSql}`,
            params
        );
        res.json({ total, limit, offset, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/attendance/:pin', async (req, res) => {
    const { pin } = req.params;
    const limit  = Math.min(int(req.query.limit, 100), 1000);
    const offset = int(req.query.offset, 0);
    try {
        const [rows] = await pool.query(
            `SELECT id, device_sn, pin, punch_time, status, verify_mode, work_code
             FROM attendance_logs
             WHERE pin = ?
             ORDER BY punch_time DESC
             LIMIT ? OFFSET ?`,
            [pin, limit, offset]
        );
        res.json({ pin, total: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/rekap', async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Format date harus YYYY-MM-DD' });
    }
    try {
        const [rows] = await pool.query(
            `SELECT
                pin,
                MIN(punch_time) AS masuk,
                MAX(punch_time) AS pulang,
                COUNT(*)        AS total_tap
             FROM attendance_logs
             WHERE DATE(punch_time) = ?
             GROUP BY pin
             ORDER BY pin`,
            [date]
        );
        res.json({ date, total_pin: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/fingerprints', async (req, res) => {
    const { pin, device_sn } = req.query;
    const where = [];
    const params = [];
    if (pin)       { where.push('pin = ?');       params.push(pin); }
    if (device_sn) { where.push('device_sn = ?'); params.push(device_sn); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    try {
        const [rows] = await pool.query(
            `SELECT id, device_sn, pin, fid, size, valid,
                    LENGTH(template_data) AS bytes_stored,
                    created_at, updated_at
             FROM fingerprint_templates
             ${whereSql}
             ORDER BY pin, fid`,
            params
        );
        res.json({ total: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/fingerprints/:pin', async (req, res) => {
    const { pin } = req.params;
    const includeRaw = req.query.raw === '1';
    try {
        const cols = includeRaw
            ? 'id, device_sn, pin, fid, size, valid, TO_BASE64(template_data) AS tmp_b64, updated_at'
            : 'id, device_sn, pin, fid, size, valid, updated_at';
        const [rows] = await pool.query(
            `SELECT ${cols} FROM fingerprint_templates WHERE pin = ? ORDER BY fid`,
            [pin]
        );
        res.json({ pin, total: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/oplogs', async (req, res) => {
    const { pin, op_type, date, device_sn } = req.query;
    const limit  = Math.min(int(req.query.limit, 100), 1000);
    const offset = int(req.query.offset, 0);
    const where = [];
    const params = [];

    if (pin)       { where.push('pin = ?');       params.push(pin); }
    if (op_type)   { where.push('op_type = ?');   params.push(int(op_type, 0)); }
    if (device_sn) { where.push('device_sn = ?'); params.push(device_sn); }
    if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Format date harus YYYY-MM-DD' });
        }
        where.push('DATE(oplog_time) = ?');
        params.push(date);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    try {
        const [rows] = await pool.query(
            `SELECT id, device_sn, pin, oplog_time, op_type, op_who, sub_type, created_at
             FROM operation_logs
             ${whereSql}
             ORDER BY oplog_time DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        res.json({ total: rows.length, limit, offset, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/devices', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                a.device_sn,
                COALESCE(d.name, '-') AS name,
                COUNT(a.id)           AS total_tap,
                MAX(a.punch_time)     AS terakhir_tap,
                (SELECT COUNT(*) FROM fingerprint_templates f WHERE f.device_sn = a.device_sn) AS total_fp
            FROM attendance_logs a
            LEFT JOIN devices d ON d.sn = a.device_sn
            GROUP BY a.device_sn, d.name
            ORDER BY terakhir_tap DESC
        `);
        res.json({ total: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/dashboard', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<title>Finger Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #f6f8fa; }
  h1 { color: #24292f; }
  .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .card { background: white; border-radius: 8px; padding: 1.2rem 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,.08); min-width: 160px; }
  .card .num { font-size: 2rem; font-weight: 700; color: #0969da; }
  .card .lbl { font-size: .85rem; color: #57606a; }
  table { width: 100%; border-collapse: collapse; background: white;
          border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { padding: .6rem 1rem; text-align: left; border-bottom: 1px solid #eaeef2; font-size: .9rem; }
  th { background: #f6f8fa; font-weight: 600; color: #57606a; }
  tr:last-child td { border-bottom: none; }
  .refresh { margin-left: 1rem; font-size: .8rem; color: #57606a; }
</style></head>
<body>
  <h1>Finger Dashboard <span class="refresh" id="last"></span></h1>
  <div class="cards" id="stats"></div>

  <h2>Absensi Hari Ini</h2>
  <table id="att"><thead>
    <tr><th>PIN</th><th>Waktu</th><th>Status</th><th>Verify</th><th>Device</th></tr>
  </thead><tbody></tbody></table>

<script>
const STATUS = { 0:'Masuk', 1:'Pulang', 2:'Break Out', 3:'Break In', 4:'OT Masuk', 5:'OT Pulang' };
const VERIFY = { 1:'Fingerprint', 2:'Kartu', 3:'Password', 15:'Wajah' };

async function load() {
  const s = await (await fetch('/api/stats')).json();
  document.getElementById('stats').innerHTML = \`
    <div class="card"><div class="num">\${s.attendance.total}</div><div class="lbl">Total Absensi</div></div>
    <div class="card"><div class="num">\${s.attendance.hari_ini}</div><div class="lbl">Hari Ini</div></div>
    <div class="card"><div class="num">\${s.fingerprint.total}</div><div class="lbl">Fingerprint</div></div>
    <div class="card"><div class="num">\${s.oplog.total}</div><div class="lbl">Operation Log</div></div>
    <div class="card"><div class="num">\${s.devices.total}</div><div class="lbl">Device</div></div>
  \`;

  const today = new Date().toISOString().slice(0,10);
  const a = await (await fetch('/api/attendance?date=' + today + '&limit=50')).json();
  const tbody = document.querySelector('#att tbody');
  tbody.innerHTML = a.data.length
    ? a.data.map(r => \`<tr>
        <td>\${r.pin}</td>
        <td>\${r.punch_time}</td>
        <td>\${STATUS[r.status] || r.status}</td>
        <td>\${VERIFY[r.verify_mode] || r.verify_mode}</td>
        <td>\${r.device_sn}</td>
      </tr>\`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:#57606a">Belum ada data hari ini</td></tr>';

  document.getElementById('last').textContent = '· diperbarui ' + new Date().toLocaleTimeString();
}
load();
setInterval(load, 5000);
</script>
</body></html>`);
});


app.use((req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => {
    console.log(`Server on :${PORT}`);
    console.log(`Dashboard : http://localhost:${PORT}/dashboard`);
});