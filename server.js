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
        const rows = fps.map(f => [
            f.sn, f.pin, f.fid, f.size, f.valid, f.templateData, f.raw
        ]);
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

app.use((req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => console.log(`Server on :${PORT}`));