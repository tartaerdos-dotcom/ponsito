const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const USERNAME = process.env.CXI_USERNAME || "CXI2026";
const PASSWORD = process.env.CXI_PASSWORD || "PROVA";
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Autenticazione
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
        return res.json({ success: true, message: "Autenticazione riuscita" });
    }
    return res.status(401).json({ success: false, message: "Credenziali non valide" });
});

// Helper per estrarre JSON dalla risposta AI
function extractJson(text) {
    let clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
    try {
        return JSON.parse(clean);
    } catch (e) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw new Error("La risposta dell'AI non contiene JSON valido");
    }
}

// API Ricerca Prospect
app.post('/api/query', async (req, res) => {
    const { query, mode } = req.body;

    if (!query) {
        return res.status(400).json({ error: "La query è obbligatoria" });
    }

    // Modalità DEMO
    if (mode === "demo") {
        const summary = "**Modalità demo:** risultati interamente fittizi per provare l'interfaccia. Non rispondono necessariamente ai filtri inseriti.";
        const rows = [
            { "Azienda": "ESEMPIO — Alfa Industriale", "Settore": "Manifatturiero", "Area": "Piemonte", "Dimensione": "Non verificata", "Priorità": "Alta", "Punteggio": 82, "Servizio suggerito": "Analisi customer journey (ipotesi)", "Interlocutore (ruolo)": "Direzione commerciale", "Motivazione": "Esempio di opportunità, non basato su dati reali", "Fonte URL": "", "Stato verifica": "FITTIZIO" },
            { "Azienda": "ESEMPIO — Beta Components", "Settore": "Automotive", "Area": "Lombardia", "Dimensione": "Non verificata", "Priorità": "Media", "Punteggio": 64, "Servizio suggerito": "Ottimizzazione esperienza clienti (ipotesi)", "Interlocutore (ruolo)": "Responsabile customer service", "Motivazione": "Esempio illustrativo", "Fonte URL": "", "Stato verifica": "FITTIZIO" },
            { "Azienda": "ESEMPIO — Gamma Solutions", "Settore": "Servizi", "Area": "Italia", "Dimensione": "Non verificata", "Priorità": "Bassa", "Punteggio": 41, "Servizio suggerito": "Analisi VOC (ipotesi)", "Interlocutore (ruolo)": "Responsabile marketing", "Motivazione": "Esempio illustrativo", "Fonte URL": "", "Stato verifica": "FITTIZIO" }
        ];
        return res.json({ summary, rows, sources: [] });
    }

    // Modalità GEMINI (API Key nascosta lato server)
    if (!API_KEY) {
        return res.status(500).json({ error: "Chiave GEMINI_API_KEY non configurata sul server." });
    }

    const prompt = `Sei un assistente di pre-vendita B2B per un progetto universitario di CXI. Il catalogo ufficiale CXI NON è disponibile: ogni servizio suggerito va etichettato come IPOTESI.
Richiesta utente: ${query}
Cerca di identificare aziende reali che soddisfino i criteri; non inventare nomi, dati, URL, persone o numeri. Se un dato non è confermato scrivi "Non verificato". Non attribuire contatti nominativi senza fonti. Se non hai accesso a fonti attendibili restituisci una lista vuota e spiega il limite.
Per ogni azienda assegna un punteggio indicativo 0-100, priorità Alta/Media/Bassa, una motivazione, un ruolo di interlocutore (non nominativo), e URL della fonte solo se realmente disponibile. Il punteggio è una valutazione ipotetica, non un fatto.
Rispondi ESCLUSIVAMENTE in JSON con oggetto: {"sintesi":"...", "aziende":[{"Azienda":"...", "Settore":"...", "Area":"...", "Dimensione":"...", "Priorità":"...", "Punteggio":0, "Servizio suggerito":"... (ipotesi)", "Interlocutore (ruolo)":"...", "Motivazione":"...", "Fonte URL":"...", "Stato verifica":"Da verificare"}]}.`;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2 }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API HTTP ${response.status}: ${errText.substring(0, 300)}`);
        }

        const data = await response.json();
        const candidates = data.candidates || [];
        if (candidates.length === 0) {
            throw new Error("Gemini non ha restituito risultati");
        }

        const parts = candidates[0].content?.parts || [];
        const rawText = parts.map(p => p.text || "").join("\n");
        const parsed = extractJson(rawText);

        const rows = parsed.aziende || [];
        const metadata = candidates[0].groundingMetadata || {};
        const sourceLinks = (metadata.groundingChunks || [])
            .map(x => x.web?.uri)
            .filter(Boolean);

        let summary = parsed.sintesi || "Risultati preliminari: verificare ogni dato.";
        summary += "\n\n⚠️ I dati e le fonti non sono stati validati da CXI.";

        return res.json({ summary, rows, sources: sourceLinks });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server CXI Sales Intelligence avviato sulla porta ${PORT}`);
});