const express = require('express');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = process.env.CXI_USERNAME || "CXI2026";
const PASSWORD = process.env.CXI_PASSWORD || "PROVA";
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Custom Instructions predefinite
let customInstructions = `Sei un assistente di pre-vendita B2B per un progetto universitario di CXI. Il catalogo ufficiale CXI NON è disponibile: ogni servizio suggerito va etichettato come IPOTESI.
Cerca di identificare aziende reali che soddisfino i criteri; non inventare nomi, dati, URL, persone o numeri. Se un dato non è confermato scrivi "Non verificato". Non attribuire contatti nominativi senza fonti. Se non hai accesso a fonti attendibili restituisci una lista vuota e spiega il limite.
Per ogni azienda assegna un punteggio indicativo 0-100, priorità Alta/Media/Bassa, una motivazione, un ruolo di interlocutore (non nominativo), e URL della fonte solo se realmente disponibile. Il punteggio è una valutazione ipotetica, non un fatto.`;

// Lista pianificazioni attive
let scheduledTasks = [];

// Configurazione Nodemailer (Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER || "",
        pass: process.env.GMAIL_PASS || ""
    }
});

// Cron job globale che controlla ogni minuto se ci sono task da eseguire (evita problemi di timezone)
cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (let i = scheduledTasks.length - 1; i >= 0; i--) {
        const task = scheduledTasks[i];
        if (now >= task.targetTime) {
            console.log(`[CRON] Esecuzione task ${task.id} per: "${task.prompt}"`);
            
            // Rimuoviamo il task dalla lista per evitare esecuzioni multiple
            scheduledTasks.splice(i, 1);

            try {
                const aiPrompt = `${customInstructions}\n\nRichiesta utente: ${task.prompt}\nRispondi ESCLUSIVAMENTE in JSON con oggetto: {"sintesi":"...", "aziende":[{"Azienda":"...", "Settore":"...", "Area":"...", "Dimensione":"...", "Priorità":"...", "Punteggio":0, "Servizio suggerito":"... (ipotesi)", "Interlocutore (ruolo)":"...", "Motivazione":"...", "Fonte URL":"...", "Stato verifica":"Da verificare"}]}.`;

                if (API_KEY) {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: aiPrompt }] }], generationConfig: { temperature: 0.2 } })
                    });

                    const data = await response.json();
                    const rawText = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
                    const parsed = extractJson(rawText);
                    const rows = parsed.aziende || [];

                    // Generazione buffer Excel
                    const ws = XLSX.utils.json_to_sheet(rows);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Prospect");
                    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

                    // Invio Email
                    if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
                        await transporter.sendMail({
                            from: process.env.GMAIL_USER,
                            to: task.email || process.env.GMAIL_USER,
                            subject: `CXI Sales Intelligence Report - ${task.prompt}`,
                            text: `Ecco il report automatico richiesto.\n\nSintesi:\n${parsed.sintesi}\n\nGenerato automaticamente dal prototipo universitario CXI.`,
                            attachments: [{ filename: 'cxi_report_automatico.xlsx', content: excelBuffer }]
                        });
                        console.log(`[CRON] Email inviata con successo a ${task.email}`);
                    }
                }
            } catch (err) {
                console.error(`[CRON] Errore esecuzione task ${task.id}:`, err.message);
            }
        }
    }
});

// API Autenticazione
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
        return res.json({ success: true, message: "Autenticazione riuscita" });
    }
    return res.status(401).json({ success: false, message: "Credenziali non valide" });
});

// API Custom Instructions
app.get('/api/instructions', (req, res) => {
    res.json({ instructions: customInstructions });
});

app.post('/api/instructions', (req, res) => {
    const { instructions } = req.body;
    if (instructions) customInstructions = instructions.trim();
    res.json({ success: true, instructions: customInstructions });
});

// Helper JSON
function extractJson(text) {
    let clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
    try {
        return JSON.parse(clean);
    } catch (e) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error("JSON non valido dall'AI");
    }
}

// API Test Invio Email Immediato
app.post('/api/test-email', async (req, res) => {
    const { email } = req.body;
    const targetEmail = email || process.env.GMAIL_USER;
    
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        return res.status(400).json({ success: false, error: "Credenziali GMAIL_USER o GMAIL_PASS non configurate su Render." });
    }

    try {
        const sampleRows = [
            { "Azienda": "Test Azienda Srl", "Settore": "Tech", "Area": "Milano", "Priorità": "Alta", "Punteggio": 90, "Servizio suggerito": "Analisi processi (ipotesi)", "Stato verifica": "Verificato" }
        ];
        const ws = XLSX.utils.json_to_sheet(sampleRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Test Prospect");
        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: targetEmail,
            subject: `CXI Sales Intelligence - Test Invio Immediato`,
            text: `Test di invio riuscito con successo!\n\nQuesto è un report Excel dimostrativo generato dal sistema CXI.`,
            attachments: [{ filename: 'cxi_test_report.xlsx', content: excelBuffer }]
        });

        res.json({ success: true, message: `Email di test inviata con successo a ${targetEmail}!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API Gestione Pianificazioni
app.get('/api/schedules', (req, res) => {
    res.json({ schedules: scheduledTasks.map(({ targetTime, ...rest }) => rest) });
});

app.post('/api/schedules', (req, res) => {
    const { prompt, datetime, email } = req.body;
    if (!prompt || !datetime) {
        return res.status(400).json({ error: "Prompt e data/ora sono obbligatori" });
    }

    const taskId = "task-" + Date.now();
    const dateObj = new Date(datetime);
    const targetTime = dateObj.getTime();

    if (isNaN(targetTime)) {
        return res.status(400).json({ error: "Data e ora non valide" });
    }

    const newTask = {
        id: taskId,
        prompt,
        datetime,
        email: email || "utente@cxi.it",
        targetTime
    };

    scheduledTasks.push(newTask);
    res.json({ success: true, message: "Pianificazione creata", schedules: scheduledTasks.map(({ targetTime, ...rest }) => rest) });
});

app.delete('/api/schedules/:id', (req, res) => {
    const { id } = req.params;
    const taskIndex = scheduledTasks.findIndex(t => t.id === id);
    if (taskIndex !== -1) {
        scheduledTasks.splice(taskIndex, 1);
    }
    res.json({ success: true, schedules: scheduledTasks.map(({ targetTime, ...rest }) => rest) });
});

// API Query normale
app.post('/api/query', async (req, res) => {
    const { query, mode } = req.body;
    if (!query) return res.status(400).json({ error: "La query è obbligatoria" });

    if (mode === "demo") {
        const summary = "**Modalità demo:** risultati interamente fittizi per provare l'interfaccia.";
        const rows = [
            { "Azienda": "ESEMPIO — Alfa Industriale", "Settore": "Manifatturiero", "Area": "Piemonte", "Dimensione": "Non verificata", "Priorità": "Alta", "Punteggio": 82, "Servizio suggerito": "Analisi customer journey (ipotesi)", "Interlocutore (ruolo)": "Direzione commerciale", "Motivazione": "Esempio dimostrativo", "Fonte URL": "", "Stato verifica": "FITTIZIO" }
        ];
        return res.json({ summary, rows, sources: [] });
    }

    if (!API_KEY) return res.status(500).json({ error: "Chiave GEMINI_API_KEY non configurata sul server." });

    const fullPrompt = `${customInstructions}\n\nRichiesta utente: ${query}\nRispondi ESCLUSIVAMENTE in JSON con oggetto: {"sintesi":"...", "aziende":[{"Azienda":"...", "Settore":"...", "Area":"...", "Dimensione":"...", "Priorità":"...", "Punteggio":0, "Servizio suggerito":"... (ipotesi)", "Interlocutore (ruolo)":"...", "Motivazione":"...", "Fonte URL":"...", "Stato verifica":"Da verificare"}]}.`;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { temperature: 0.2 } })
        });

        if (!response.ok) throw new Error(`Gemini API HTTP ${response.status}`);
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
        const parsed = extractJson(rawText);

        return res.json({ summary: parsed.sintesi, rows: parsed.aziende || [], sources: [] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server CXI Sales Intelligence avviato sulla porta ${PORT}`);
});
