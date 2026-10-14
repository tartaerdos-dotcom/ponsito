'use strict';

/**
 * CXI Sales Intelligence Agent B2B - server
 *
 * Variabili d'ambiente (Render > Environment):
 *   CXI_USERNAME, CXI_PASSWORD   credenziali di accesso (obbligatorie in produzione)
 *   SESSION_SECRET               stringa casuale lunga per firmare i token di sessione
 *   GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.5-flash)
 *   GEMINI_GROUNDING             "true" (default) abilita Google Search come fonte
 *   EMAIL_PROVIDER               "brevo" (default) | "resend" | "smtp"
 *   EMAIL_FROM, EMAIL_FROM_NAME  mittente (per Brevo deve essere un sender verificato)
 *   BREVO_API_KEY                se EMAIL_PROVIDER=brevo
 *   RESEND_API_KEY               se EMAIL_PROVIDER=resend
 *   GMAIL_USER, GMAIL_PASS       se EMAIL_PROVIDER=smtp (App Password Google; NON funziona sul piano free di Render)
 *   CRON_SECRET                  chiave per l'endpoint /api/cron/tick richiamabile da un cron esterno
 *   APP_TIMEZONE                 default Europe/Rome (solo per la formattazione di date nei report)
 *   DATA_DIR                     cartella in cui salvare pianificazioni e istruzioni (default: cartella del progetto)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.APP_TIMEZONE || 'Europe/Rome';

const USERNAME = process.env.CXI_USERNAME || 'CXI2026';
const PASSWORD = process.env.CXI_PASSWORD || 'PROVA';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CRON_SECRET = process.env.CRON_SECRET || '';

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROUNDING = (process.env.GEMINI_GROUNDING || 'true').toLowerCase() === 'true';
const GEMINI_TIMEOUT_MS = 120 * 1000;

const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'brevo').toLowerCase();
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.GMAIL_USER || '';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'CXI Sales Intelligence';

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'cxi-data.json');
const TICK_INTERVAL_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;

if (!process.env.CXI_USERNAME || !process.env.CXI_PASSWORD) {
    console.warn('[AVVISO] CXI_USERNAME/CXI_PASSWORD non impostate: in uso le credenziali di default.');
}
if (!process.env.SESSION_SECRET) {
    console.warn('[AVVISO] SESSION_SECRET non impostata: le sessioni verranno invalidate a ogni riavvio.');
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Stato applicativo e persistenza                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_INSTRUCTIONS = `Sei un assistente di pre-vendita B2B per un progetto universitario di CXI. Il catalogo ufficiale CXI NON è disponibile: ogni servizio suggerito va etichettato come IPOTESI.
Cerca di identificare aziende reali che soddisfino i criteri; non inventare nomi, dati, URL, persone o numeri. Se un dato non è confermato scrivi "Non verificato". Non attribuire contatti nominativi senza fonti. Se non hai accesso a fonti attendibili restituisci una lista vuota e spiega il limite.
Per ogni azienda assegna un punteggio indicativo 0-100, priorità Alta/Media/Bassa, una motivazione, un ruolo di interlocutore (non nominativo), e URL della fonte solo se realmente disponibile. Il punteggio è una valutazione ipotetica, non un fatto.`;

const JSON_FORMAT = `Rispondi ESCLUSIVAMENTE in JSON con oggetto: {"sintesi":"...", "aziende":[{"Azienda":"...", "Settore":"...", "Area":"...", "Dimensione":"...", "Priorità":"...", "Punteggio":0, "Servizio suggerito":"... (ipotesi)", "Interlocutore (ruolo)":"...", "Motivazione":"...", "Fonte URL":"...", "Stato verifica":"Da verificare"}]}.`;

const COLUMNS = ['Azienda', 'Settore', 'Area', 'Dimensione', 'Priorità', 'Punteggio', 'Servizio suggerito',
    'Interlocutore (ruolo)', 'Motivazione', 'Fonte URL', 'Stato verifica'];

let state = { instructions: DEFAULT_INSTRUCTIONS, tasks: [] };

function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            state.instructions = saved.instructions || DEFAULT_INSTRUCTIONS;
            state.tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
            // Un task rimasto "running" per un riavvio va rimesso in coda
            state.tasks.forEach(t => { if (t.status === 'running') t.status = 'pending'; });
            console.log(`[DATI] Caricate ${state.tasks.length} pianificazioni da ${DATA_FILE}`);
        }
    } catch (err) {
        console.error('[DATI] Impossibile leggere il file dati:', err.message);
    }
}

function saveState() {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('[DATI] Impossibile salvare il file dati:', err.message);
    }
}

loadState();

/* ------------------------------------------------------------------ */
/* Autenticazione (token firmato HMAC, nessuna dipendenza esterna)     */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createToken() {
    const exp = String(Date.now() + SESSION_TTL_MS);
    return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return false;
    const [exp, sig] = token.split('.');
    return safeEqual(sig, sign(exp)) && Number(exp) > Date.now();
}

function requireAuth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (verifyToken(token)) return next();
    return res.status(401).json({ error: 'Sessione scaduta o non valida: effettuare nuovamente l\'accesso.' });
}

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (safeEqual(username || '', USERNAME) && safeEqual(password || '', PASSWORD)) {
        return res.json({ success: true, token: createToken(), message: 'Autenticazione riuscita' });
    }
    return res.status(401).json({ success: false, message: 'Credenziali non valide' });
});

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

function extractJson(text) {
    const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(clean);
    } catch (e) {
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start !== -1 && end > start) return JSON.parse(clean.slice(start, end + 1));
        throw new Error('La risposta dell\'AI non contiene JSON valido');
    }
}

async function callGemini(userRequest) {
    if (!API_KEY) throw new Error('Chiave GEMINI_API_KEY non configurata sul server.');

    const prompt = `${state.instructions}\n\nRichiesta utente: ${userRequest}\n${JSON_FORMAT}`;
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
    };
    // Senza questo strumento il modello non consulta il web e tende a inventare URL e dati
    if (GROUNDING) body.tools = [{ google_search: {} }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        throw new Error(err.name === 'AbortError' ? 'Timeout nella risposta di Gemini' : `Errore di rete verso Gemini: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API HTTP ${response.status}: ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
        const reason = data.promptFeedback?.blockReason;
        throw new Error(`Gemini non ha restituito risultati${reason ? ` (blocco: ${reason})` : ''}`);
    }

    const rawText = (candidate.content?.parts || []).map(p => p.text || '').join('\n');
    if (!rawText.trim()) throw new Error(`Risposta vuota da Gemini (finishReason: ${candidate.finishReason || 'n/d'})`);

    const parsed = extractJson(rawText);
    const rows = Array.isArray(parsed.aziende) ? parsed.aziende.filter(r => r && typeof r === 'object') : [];
    const sources = [...new Set((candidate.groundingMetadata?.groundingChunks || [])
        .map(c => c.web?.uri).filter(Boolean))];

    let summary = parsed.sintesi || 'Risultati preliminari: verificare ogni dato.';
    summary += '\n\n⚠️ I dati e le fonti non sono stati validati da CXI.';
    return { summary, rows, sources };
}

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

function formatDate(d) {
    return new Date(d).toLocaleString('it-IT', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
}

function buildExcel({ prompt, summary, rows, sources }) {
    const wb = XLSX.utils.book_new();

    const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
    ws['!cols'] = COLUMNS.map(col => ({
        wch: Math.min(60, Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length)) + 2)
    }));
    XLSX.utils.book_append_sheet(wb, ws, 'Prospect');

    const info = XLSX.utils.aoa_to_sheet([
        ['Richiesta', prompt],
        ['Generato il', `${formatDate(Date.now())} (${TZ})`],
        ['Sintesi', summary],
        ['Avvertenza', 'Prototipo universitario: dati, punteggi e fonti da verificare prima di qualsiasi uso commerciale.'],
        [],
        ['Fonti consultate dal modello'],
        ...(sources.length ? sources.map(s => [s]) : [['Nessuna fonte restituita']])
    ]);
    info['!cols'] = [{ wch: 28 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, info, 'Info');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ------------------------------------------------------------------ */
/* Email: provider HTTPS (funzionano sul piano free di Render)         */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailConfigError() {
    if (!EMAIL_FROM) return 'EMAIL_FROM (o GMAIL_USER) non configurata.';
    if (EMAIL_PROVIDER === 'brevo' && !process.env.BREVO_API_KEY) return 'BREVO_API_KEY non configurata.';
    if (EMAIL_PROVIDER === 'resend' && !process.env.RESEND_API_KEY) return 'RESEND_API_KEY non configurata.';
    if (EMAIL_PROVIDER === 'smtp' && (!process.env.GMAIL_USER || !process.env.GMAIL_PASS)) return 'GMAIL_USER o GMAIL_PASS non configurate.';
    if (!['brevo', 'resend', 'smtp'].includes(EMAIL_PROVIDER)) return `EMAIL_PROVIDER "${EMAIL_PROVIDER}" non supportato.`;
    return null;
}

async function postJson(url, headers, payload, label) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${label} HTTP ${res.status}: ${txt.substring(0, 300)}`);
    }
    return res.json().catch(() => ({}));
}

async function sendEmail({ to, subject, text, attachments = [] }) {
    const configError = emailConfigError();
    if (configError) throw new Error(`Invio email non configurato: ${configError}`);

    if (EMAIL_PROVIDER === 'brevo') {
        return postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': process.env.BREVO_API_KEY }, {
            sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
            to: [{ email: to }],
            subject,
            textContent: text,
            attachment: attachments.map(a => ({ name: a.filename, content: a.content.toString('base64') }))
        }, 'Brevo');
    }

    if (EMAIL_PROVIDER === 'resend') {
        return postJson('https://api.resend.com/emails', { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, {
            from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
            to: [to],
            subject,
            text,
            attachments: attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') }))
        }, 'Resend');
    }

    // SMTP (Gmail): richiede un'istanza Render a pagamento, perché il piano free blocca le porte 465/587
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 465),
        secure: Number(process.env.SMTP_PORT || 465) === 465,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
        connectionTimeout: 15000,
        greetingTimeout: 10000
    });
    return transporter.sendMail({ from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`, to, subject, text, attachments });
}

/* ------------------------------------------------------------------ */
/* Pianificazioni                                                      */
/* ------------------------------------------------------------------ */

const REPEAT_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

function publicTask(t) {
    const { nextAttemptAt, ...rest } = t;
    return rest;
}

function listTasks() {
    return [...state.tasks].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt)).map(publicTask);
}

async function runReport(task) {
    const result = await callGemini(task.prompt);
    const excelBuffer = buildExcel({ prompt: task.prompt, ...result });
    const subjectPrompt = task.prompt.length > 80 ? `${task.prompt.slice(0, 77)}...` : task.prompt;
    await sendEmail({
        to: task.email,
        subject: `CXI Sales Intelligence Report - ${subjectPrompt}`,
        text: `Report automatico generato il ${formatDate(Date.now())}.\n\nRichiesta: ${task.prompt}\n\nSintesi:\n${result.summary}\n\nAziende individuate: ${result.rows.length}\n\nGenerato automaticamente dal prototipo universitario CXI. Verificare ogni dato prima dell'uso.`,
        attachments: [{ filename: 'cxi_report_automatico.xlsx', content: excelBuffer }]
    });
    return result;
}

async function executeTask(task) {
    task.status = 'running';
    task.attempts = (task.attempts || 0) + 1;
    saveState();
    console.log(`[SCHEDULER] Esecuzione ${task.id} (tentativo ${task.attempts}): "${task.prompt}"`);

    try {
        const result = await runReport(task);
        task.lastRunAt = new Date().toISOString();
        task.lastResult = `Inviato a ${task.email} (${result.rows.length} aziende)`;
        task.lastError = null;
        task.attempts = 0;
        delete task.nextAttemptAt;

        if (REPEAT_MS[task.repeat]) {
            let next = Date.parse(task.runAt);
            while (next <= Date.now()) next += REPEAT_MS[task.repeat];
            task.runAt = new Date(next).toISOString();
            task.status = 'pending';
        } else {
            task.status = 'sent';
        }
        console.log(`[SCHEDULER] ${task.id} completato: ${task.lastResult}`);
    } catch (err) {
        task.lastError = err.message;
        if (task.attempts < MAX_ATTEMPTS) {
            task.status = 'pending';
            task.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
        } else {
            task.status = 'error';
            delete task.nextAttemptAt;
        }
        console.error(`[SCHEDULER] Errore ${task.id}:`, err.message);
    }
    saveState();
}

let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const now = Date.now();
        const due = state.tasks.filter(t =>
            t.status === 'pending' && Date.parse(t.nextAttemptAt || t.runAt) <= now);
        for (const task of due) await executeTask(task);
    } finally {
        ticking = false;
    }
}

setInterval(() => tick().catch(err => console.error('[SCHEDULER]', err.message)), TICK_INTERVAL_MS);

/* ------------------------------------------------------------------ */
/* Endpoint pubblici di servizio                                       */
/* ------------------------------------------------------------------ */

// Da usare con un monitor esterno (es. cron-job.org, UptimeRobot) per evitare la sospensione del servizio
app.get('/health', (req, res) => {
    tick().catch(() => {});
    res.json({ ok: true, pending: state.tasks.filter(t => t.status === 'pending').length });
});

// Trigger esplicito dello scheduler da un cron esterno: GET /api/cron/tick?secret=...
app.get('/api/cron/tick', async (req, res) => {
    if (!CRON_SECRET || !safeEqual(req.query.secret || '', CRON_SECRET)) {
        return res.status(403).json({ error: 'Non autorizzato' });
    }
    await tick();
    res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Endpoint protetti                                                   */
/* ------------------------------------------------------------------ */

app.use('/api', requireAuth);

app.get('/api/status', (req, res) => {
    res.json({
        gemini: Boolean(API_KEY),
        grounding: GROUNDING,
        emailProvider: EMAIL_PROVIDER,
        emailError: emailConfigError(),
        persistenceFile: DATA_FILE
    });
});

app.get('/api/instructions', (req, res) => {
    res.json({ instructions: state.instructions });
});

app.post('/api/instructions', (req, res) => {
    const instructions = String(req.body?.instructions || '').trim();
    if (!instructions) return res.status(400).json({ error: 'Le istruzioni non possono essere vuote' });
    if (instructions.length > 8000) return res.status(400).json({ error: 'Istruzioni troppo lunghe (max 8000 caratteri)' });
    state.instructions = instructions;
    saveState();
    res.json({ success: true, instructions: state.instructions });
});

app.post('/api/test-email', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: 'Indicare un indirizzo email valido.' });

    const configError = emailConfigError();
    if (configError) return res.status(400).json({ success: false, error: `Invio email non configurato: ${configError}` });

    try {
        const rows = [{
            'Azienda': 'ESEMPIO — Test Azienda Srl', 'Settore': 'Tech', 'Area': 'Milano', 'Dimensione': 'Non verificata',
            'Priorità': 'Alta', 'Punteggio': 90, 'Servizio suggerito': 'Analisi processi (ipotesi)',
            'Interlocutore (ruolo)': 'Direzione commerciale', 'Motivazione': 'Riga di prova', 'Fonte URL': '',
            'Stato verifica': 'FITTIZIO'
        }];
        const excelBuffer = buildExcel({ prompt: 'Test invio', summary: 'Report di prova con dati fittizi.', rows, sources: [] });
        await sendEmail({
            to: email,
            subject: 'CXI Sales Intelligence - Test invio immediato',
            text: 'Test di invio riuscito.\n\nIn allegato un report Excel dimostrativo con dati fittizi generato dal sistema CXI.',
            attachments: [{ filename: 'cxi_test_report.xlsx', content: excelBuffer }]
        });
        res.json({ success: true, message: `Email di test inviata a ${email} tramite ${EMAIL_PROVIDER}.` });
    } catch (err) {
        console.error('[TEST-EMAIL]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/schedules', (req, res) => {
    res.json({ schedules: listTasks() });
});

app.post('/api/schedules', (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    const email = String(req.body?.email || '').trim();
    const repeat = ['none', 'daily', 'weekly'].includes(req.body?.repeat) ? req.body.repeat : 'none';
    const runAtMs = Date.parse(req.body?.runAt || req.body?.datetime || '');

    if (!prompt) return res.status(400).json({ error: 'Il prompt è obbligatorio' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'Prompt troppo lungo (max 2000 caratteri)' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Indicare un indirizzo email valido' });
    if (isNaN(runAtMs)) return res.status(400).json({ error: 'Data e ora non valide' });
    if (runAtMs < Date.now() - 60 * 1000) return res.status(400).json({ error: 'La data indicata è già trascorsa' });

    const task = {
        id: `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        prompt,
        email,
        repeat,
        runAt: new Date(runAtMs).toISOString(),
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        lastResult: null,
        lastError: null
    };
    state.tasks.push(task);
    saveState();

    const warning = emailConfigError();
    res.json({
        success: true,
        message: warning ? `Pianificazione creata, ma l'invio fallirà finché non si risolve: ${warning}` : 'Pianificazione creata',
        schedules: listTasks()
    });
});

// Esecuzione immediata di una pianificazione esistente (non altera la data programmata)
app.post('/api/schedules/:id/run', async (req, res) => {
    const task = state.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Pianificazione non trovata' });
    if (task.status === 'running') return res.status(409).json({ error: 'Pianificazione già in esecuzione' });

    try {
        const result = await runReport(task);
        task.lastRunAt = new Date().toISOString();
        task.lastResult = `Inviato manualmente a ${task.email} (${result.rows.length} aziende)`;
        task.lastError = null;
        saveState();
        res.json({ success: true, message: task.lastResult, schedules: listTasks() });
    } catch (err) {
        task.lastError = err.message;
        saveState();
        res.status(500).json({ error: err.message, schedules: listTasks() });
    }
});

app.delete('/api/schedules/:id', (req, res) => {
    state.tasks = state.tasks.filter(t => t.id !== req.params.id);
    saveState();
    res.json({ success: true, schedules: listTasks() });
});

app.post('/api/query', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    const mode = req.body?.mode;
    if (!query) return res.status(400).json({ error: 'La query è obbligatoria' });

    if (mode === 'demo') {
        const summary = '**Modalità demo:** risultati interamente fittizi per provare l\'interfaccia. Non rispondono necessariamente ai filtri inseriti.';
        const rows = [
            { 'Azienda': 'ESEMPIO — Alfa Industriale', 'Settore': 'Manifatturiero', 'Area': 'Piemonte', 'Dimensione': 'Non verificata', 'Priorità': 'Alta', 'Punteggio': 82, 'Servizio suggerito': 'Analisi customer journey (ipotesi)', 'Interlocutore (ruolo)': 'Direzione commerciale', 'Motivazione': 'Esempio di opportunità, non basato su dati reali', 'Fonte URL': '', 'Stato verifica': 'FITTIZIO' },
            { 'Azienda': 'ESEMPIO — Beta Components', 'Settore': 'Automotive', 'Area': 'Lombardia', 'Dimensione': 'Non verificata', 'Priorità': 'Media', 'Punteggio': 64, 'Servizio suggerito': 'Ottimizzazione esperienza clienti (ipotesi)', 'Interlocutore (ruolo)': 'Responsabile customer service', 'Motivazione': 'Esempio illustrativo', 'Fonte URL': '', 'Stato verifica': 'FITTIZIO' },
            { 'Azienda': 'ESEMPIO — Gamma Solutions', 'Settore': 'Servizi', 'Area': 'Italia', 'Dimensione': 'Non verificata', 'Priorità': 'Bassa', 'Punteggio': 41, 'Servizio suggerito': 'Analisi VOC (ipotesi)', 'Interlocutore (ruolo)': 'Responsabile marketing', 'Motivazione': 'Esempio illustrativo', 'Fonte URL': '', 'Stato verifica': 'FITTIZIO' }
        ];
        return res.json({ summary, rows, sources: [] });
    }

    try {
        return res.json(await callGemini(query));
    } catch (err) {
        console.error('[QUERY]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server CXI Sales Intelligence avviato sulla porta ${PORT}`);
    console.log(`[EMAIL] Provider: ${EMAIL_PROVIDER}${emailConfigError() ? ` (NON configurato: ${emailConfigError()})` : ''}`);
    tick().catch(() => {});
});
