const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

// Configurazione trasportatore Gmail
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, // es. la tua mail gmail
        pass: process.env.GMAIL_PASS  // la password per le app di Google
    }
});

// All'interno del cron job:
const job = cron.schedule(cronCronExpression, async () => {
    console.log(`[CRON] Esecuzione pianificazione ${taskId} per il prompt: "${prompt}"`);
    try {
        // 1. Chiamata interna a Gemini usando le Custom Instructions attuali
        const aiPrompt = `${customInstructions}\n\nRichiesta utente: ${prompt}\nRispondi ESCLUSIVAMENTE in JSON con oggetto: {"sintesi":"...", "aziende":[{"Azienda":"...", "Settore":"...", "Area":"...", "Dimensione":"...", "Priorità":"...", "Punteggio":0, "Servizio suggerito":"... (ipotesi)", "Interlocutore (ruolo)":"...", "Motivazione":"...", "Fonte URL":"...", "Stato verifica":"Da verificare"}]}.`;
        
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

        // 2. Generazione del file Excel in memoria con SheetJS
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Prospect");
        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        // 3. Invio della mail con allegato
        await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject: `CXI Sales Intelligence Report - ${prompt}`,
            text: `Ecco il report automatico richiesto.\n\nSintesi:\n${parsed.sintesi}\n\nGenerato automaticamente dal prototipo universitario CXI.`,
            attachments: [
                {
                    filename: 'cxi_report_automatico.xlsx',
                    content: excelBuffer
                }
            ]
        });

        console.log(`[CRON] Report Excel inviato con successo a ${email}`);
    } catch (err) {
        console.error(`[CRON] Errore esecuzione task ${taskId}:`, err.message);
    }
});