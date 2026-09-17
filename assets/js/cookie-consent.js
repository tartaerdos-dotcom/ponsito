/**
 * cookie-consent.js
 * Gestione granulare del consenso dei cookie conforme al GDPR e alle
 * Linee guida del Garante Privacy italiano (10/06/2021).
 * 
 * Inserisce dinamicamente il banner e controlla il blocco/attivazione
 * preventiva degli script statistici e di marketing.
 */

(function () {
  'use strict';

  // Chiave localStorage per salvare le preferenze
  const STORAGE_KEY = 'cookie_consent_preferences';

  // Oggetto per memorizzare lo stato dei consensi
  let consent = {
    necessary: true,
    statistics: false,
    marketing: false
  };

  // Carica le preferenze esistenti
  function loadPreferences() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        consent.necessary = true; // Sempre vero per legge
        consent.statistics = !!parsed.statistics;
        consent.marketing = !!parsed.marketing;
        return true;
      } catch (e) {
        console.error("Errore nella lettura delle preferenze cookie:", e);
      }
    }
    return false;
  }

  // Salva le preferenze
  function savePreferences(stats, mkt) {
    consent.statistics = stats;
    consent.marketing = mkt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
    
    // Attiva gli script per cui è stato dato il consenso
    activateScripts();
    
    // Chiude il banner
    hideBanner();

    // Invia un evento custom per le pagine che devono reagire al cambio di consenso (es. Google Maps)
    window.dispatchEvent(new CustomEvent('cookieConsentChanged', { detail: consent }));
  }

  // Inietta dinamicamente gli elementi HTML del banner se non già presenti
  function injectBannerHTML() {
    if (document.getElementById('cookie-consent-overlay')) return;

    // Crea l'overlay per lo sfondo scuro (facilita il focus ed evita interazioni accidentali)
    const overlay = document.createElement('div');
    overlay.id = 'cookie-consent-overlay';
    overlay.className = 'cookie-overlay';
    document.body.appendChild(overlay);

    // Crea il banner principale
    const banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-modal', 'true');
    banner.setAttribute('aria-labelledby', 'cookie-title');
    banner.setAttribute('aria-describedby', 'cookie-desc');

    banner.innerHTML = `
      <div class="cookie-title" id="cookie-title">
        🍪 Informativa sui Cookie
      </div>
      <div class="cookie-text" id="cookie-desc">
        Questo sito utilizza cookie necessari per garantire il corretto funzionamento e, previo tuo consenso, cookie statistici e di marketing per analizzare il traffico e offrirti contenuti personalizzati. Puoi decidere liberamente quali accettare. Consulta la nostra 
        <a href="cookie-policy.html" target="_blank" rel="noopener">Cookie Policy</a> e la nostra 
        <a href="privacy-policy.html" target="_blank" rel="noopener">Privacy Policy</a> per maggiori dettagli.
      </div>
      
      <div class="cookie-buttons">
        <div class="cookie-buttons-row">
          <button type="button" class="cookie-btn cookie-btn-accept" id="cookie-accept-all">Accetta tutti</button>
          <button type="button" class="cookie-btn cookie-btn-reject" id="cookie-reject-all">Rifiuta non necessari</button>
        </div>
        <button type="button" class="cookie-btn cookie-btn-customize" id="cookie-toggle-customize">Personalizza preferenze</button>
      </div>

      <!-- Schermata di personalizzazione granulare -->
      <div class="cookie-custom-panel" id="cookie-custom-panel">
        <div class="cookie-category-item">
          <div class="cookie-category-info">
            <div class="cookie-category-title">Cookie Tecnici / Necessari</div>
            <div class="cookie-category-desc">Essenziali per la navigazione, la sicurezza e il funzionamento del sito. Non possono essere disattivati.</div>
          </div>
          <label class="switch" aria-label="Attiva cookie necessari">
            <input type="checkbox" checked disabled>
            <span class="slider"></span>
          </label>
        </div>

        <div class="cookie-category-item">
          <div class="cookie-category-info">
            <div class="cookie-category-title">Cookie Statistici / Analitici</div>
            <div class="cookie-category-desc">Permettono di raccogliere dati in forma anonima e aggregata sull'uso del sito per migliorarne le prestazioni.</div>
          </div>
          <label class="switch" aria-label="Attiva cookie statistici">
            <input type="checkbox" id="cookie-chk-statistics">
            <span class="slider"></span>
          </label>
        </div>

        <div class="cookie-category-item">
          <div class="cookie-category-info">
            <div class="cookie-category-title">Cookie di Marketing / Profilazione</div>
            <div class="cookie-category-desc">Utilizzati per tracciare i visitatori tra i siti web, al fine di mostrare annunci pertinenti e coinvolgenti.</div>
          </div>
          <label class="switch" aria-label="Attiva cookie di marketing">
            <input type="checkbox" id="cookie-chk-marketing">
            <span class="slider"></span>
          </label>
        </div>

        <div class="cookie-buttons" style="margin-top: 1rem;">
          <button type="button" class="cookie-btn cookie-btn-accept" id="cookie-save-custom">Salva selezioni</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    // Registra i gestori di eventi per i bottoni del banner
    document.getElementById('cookie-accept-all').addEventListener('click', function () {
      savePreferences(true, true);
    });

    document.getElementById('cookie-reject-all').addEventListener('click', function () {
      savePreferences(false, false);
    });

    document.getElementById('cookie-toggle-customize').addEventListener('click', function () {
      const panel = document.getElementById('cookie-custom-panel');
      panel.classList.toggle('active');
      
      // Sincronizza lo stato delle checkbox
      document.getElementById('cookie-chk-statistics').checked = consent.statistics;
      document.getElementById('cookie-chk-marketing').checked = consent.marketing;
    });

    document.getElementById('cookie-save-custom').addEventListener('click', function () {
      const stats = document.getElementById('cookie-chk-statistics').checked;
      const mkt = document.getElementById('cookie-chk-marketing').checked;
      savePreferences(stats, mkt);
    });
  }

  // Mostra il banner con animazione
  function showBanner() {
    injectBannerHTML();
    
    const banner = document.getElementById('cookie-consent-banner');
    const overlay = document.getElementById('cookie-consent-overlay');
    
    // Rende attivi i tag HTML
    banner.classList.add('active');
    overlay.classList.add('active');
    
    // Forza reflow e aggiunge classe di transizione
    setTimeout(() => {
      banner.classList.add('visible');
      overlay.classList.add('visible');
      // Sposta il focus sul primo bottone del banner per accessibilità
      document.getElementById('cookie-accept-all').focus();
    }, 50);
  }

  // Nasconde il banner con animazione
  function hideBanner() {
    const banner = document.getElementById('cookie-consent-banner');
    const overlay = document.getElementById('cookie-consent-overlay');
    
    if (banner && overlay) {
      banner.classList.remove('visible');
      overlay.classList.remove('visible');
      
      // Attende la fine dell'animazione CSS prima di nascondere il markup
      setTimeout(() => {
        banner.classList.remove('active');
        overlay.classList.remove('active');
      }, 300);
    }
  }

  // Attiva gli script in base al consenso fornito (blocco preventivo)
  function activateScripts() {
    // 1. Script Statistici
    if (consent.statistics) {
      executeBlockedScripts('statistics');
    }
    // 2. Script di Marketing
    if (consent.marketing) {
      executeBlockedScripts('marketing');
    }
  }

  // Esegue gli script bloccati con data-cookie-category
  function executeBlockedScripts(category) {
    const scripts = document.querySelectorAll(`script[type="text/plain"][data-cookie-category="${category}"]`);
    
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      
      // Copia tutti gli attributi
      Array.from(oldScript.attributes).forEach(attr => {
        if (attr.name !== 'type') {
          newScript.setAttribute(attr.name, attr.value);
        }
      });
      
      // Imposta il tipo corretto
      newScript.type = 'text/javascript';
      
      // Copia il contenuto interno per gli script inline
      newScript.innerHTML = oldScript.innerHTML;
      
      // Sostituisce lo script vecchio con quello attivo
      oldScript.parentNode.replaceChild(newScript, oldScript);
      
      console.log(`Script cookie attivato per categoria: ${category}`, newScript.src || 'inline script');
    });
  }

  // Rende globale la funzione per gestire il banner da link esterni
  window.cookieConsentManager = {
    show: function () {
      showBanner();
      // Apre direttamente il pannello personalizzazione per consentire la revoca rapida
      setTimeout(() => {
        const panel = document.getElementById('cookie-custom-panel');
        if (panel) {
          panel.classList.add('active');
          document.getElementById('cookie-chk-statistics').checked = consent.statistics;
          document.getElementById('cookie-chk-marketing').checked = consent.marketing;
          document.getElementById('cookie-chk-statistics').focus();
        }
      }, 100);
    },
    getConsent: function () {
      return { ...consent };
    }
  };

  // Inizializzazione all'avvio della pagina
  document.addEventListener('DOMContentLoaded', function () {
    const hasPreferences = loadPreferences();
    
    if (!hasPreferences) {
      // Nessuna scelta salvata: mostra il banner per raccogliere il consenso preventivo
      showBanner();
    } else {
      // Scelta già salvata: attiva gli script consentiti
      activateScripts();
    }

    // Collega l'evento click a tutti i bottoni/link "Gestisci cookie"
    // Cerca elementi con classe 'cookie-consent-manage' o selettori simili nel footer
    const manageLinks = document.querySelectorAll('.cookie-consent-manage, #cookie-consent-manage-link');
    manageLinks.forEach(link => {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        window.cookieConsentManager.show();
      });
    });

    // Gestore menu mobile
    const menuToggle = document.getElementById('menu-toggle');
    const navMenu = document.getElementById('nav-menu');
    if (menuToggle && navMenu) {
      menuToggle.addEventListener('click', function () {
        const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
        menuToggle.setAttribute('aria-expanded', !expanded);
        navMenu.classList.toggle('active');
      });
    }
  });

})();
