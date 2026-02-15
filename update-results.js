const fs = require('fs');
const path = require('path');

const SPIELPLAN_FILE = path.join(__dirname, 'spielplan.json');

// TheSportsDB - komplett gratis, kein API-Key nötig
const API_BASE = 'https://www.thesportsdb.com/api/v1/json/3/eventsround.php';
const LEAGUE_ID = 4675; // Swiss Super League
const SEASON = '2025-2026';

// Mapping: TheSportsDB Teamnamen → spielplan.json Teamnamen
const TEAM_MAP = {
    'Zürich': 'FC Zürich',
    'Sion': 'FC Sion',
    'Grasshoppers': 'Grasshoppers',
    'Luzern': 'FC Luzern',
    'St. Gallen': 'FC St. Gallen',
    'Basel': 'FC Basel',
    'Young Boys': 'BSC Young Boys',
    'Servette': 'Servette FC',
    'Lausanne-Sport': 'Lausanne-Sport',
    'Winterthur': 'FC Winterthur',
    'Lugano': 'FC Lugano',
    'Thun': 'FC Thun'
};

function mapTeamName(apiName) {
    return TEAM_MAP[apiName] || apiName;
}

async function updateResults() {
    console.log('=== Resultate-Update ===');
    console.log(`Zeit: ${new Date().toISOString()}`);

    const spielplan = JSON.parse(fs.readFileSync(SPIELPLAN_FILE, 'utf8'));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let updatedCount = 0;

    for (let i = 0; i < spielplan.matchdays.length; i++) {
        const matchday = spielplan.matchdays[i];

        // Nur Spieltage abfragen, die Spiele ohne Resultat haben
        const matchesMissingResult = matchday.matches.filter(m => !m.result);
        if (matchesMissingResult.length === 0) continue;

        // Resultate erst eintragen, wenn der NÄCHSTE Spieltag begonnen hat
        const nextMatchday = spielplan.matchdays[i + 1];
        if (!nextMatchday) continue; // Letzter Spieltag: warten bis Saison vorbei

        const nextFirstMatch = new Date(nextMatchday.matches[0].date);
        nextFirstMatch.setHours(0, 0, 0, 0);

        if (today < nextFirstMatch) {
            console.log(`Spieltag ${matchday.matchday}: Übersprungen (Spieltag ${nextMatchday.matchday} hat noch nicht begonnen)`);
            continue;
        }

        // API abfragen
        const url = `${API_BASE}?id=${LEAGUE_ID}&r=${matchday.matchday}&s=${SEASON}`;
        console.log(`\nSpieltag ${matchday.matchday}: Lade Resultate...`);

        try {
            const res = await fetch(url);
            const data = await res.json();
            const events = data.events || [];

            for (const event of events) {
                // Nur abgeschlossene Spiele
                if (event.strStatus !== 'Match Finished') continue;

                const homeApi = mapTeamName(event.strHomeTeam);
                const awayApi = mapTeamName(event.strAwayTeam);
                const scoreHome = event.intHomeScore;
                const scoreAway = event.intAwayScore;

                if (scoreHome === null || scoreAway === null) continue;

                // Passendes Spiel in spielplan.json finden
                const match = matchday.matches.find(m =>
                    m.home === homeApi && m.away === awayApi && !m.result
                );

                if (match) {
                    match.result = `${scoreHome}:${scoreAway}`;
                    updatedCount++;
                    console.log(`  ✓ ${homeApi} - ${awayApi}: ${match.result}`);
                }
            }
        } catch (e) {
            console.error(`  ✗ Fehler bei Spieltag ${matchday.matchday}:`, e.message);
        }

        // Pause zwischen API-Calls (Rate Limiting)
        await new Promise(r => setTimeout(r, 1000));
    }

    if (updatedCount > 0) {
        fs.writeFileSync(SPIELPLAN_FILE, JSON.stringify(spielplan, null, 2), 'utf8');
        console.log(`\n${updatedCount} Resultate aktualisiert in spielplan.json`);
    } else {
        console.log('\nKeine neuen Resultate gefunden.');
    }
}

updateResults().catch(error => {
    console.error('Fehler:', error);
    process.exit(1);
});
