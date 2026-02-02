const fs = require('fs');
const path = require('path');

// Konfiguration - Interne SRF API (keine Auth nötig!)
const API_BASE = 'https://il.srgssr.ch/integrationlayer/2.0/srf/searchResultMediaList';
const LINKS_FILE = path.join(__dirname, 'links.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');
const SPIELPLAN_FILE = path.join(__dirname, 'spielplan.json');

// Lade JSON-Dateien
function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Fehler beim Laden von ${filePath}:`, error.message);
        return null;
    }
}

// Speichere JSON-Datei
function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// API-Suche nach Videos
async function searchVideos(query) {
    const url = `${API_BASE}?q=${encodeURIComponent(query)}`;
    
    console.log(`  API-Suche: "${query}"`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
        console.error(`  API-Fehler: ${response.status} ${response.statusText}`);
        return [];
    }
    
    const data = await response.json();
    return data.searchResultMediaList || [];
}

// Prüfe ob ein Team-Keyword im Text vorkommt
function findTeamInText(text, teamName, teamsData) {
    const textLower = text.toLowerCase();
    
    // Prüfe Team-Keywords
    const teamInfo = teamsData.teams[teamName];
    if (teamInfo && teamInfo.keywords) {
        for (const keyword of teamInfo.keywords) {
            if (textLower.includes(keyword.toLowerCase())) {
                return true;
            }
        }
    }
    
    // Prüfe auch den Teamnamen selbst
    if (textLower.includes(teamName.toLowerCase())) {
        return true;
    }
    
    return false;
}

// Prüfe ob das Video-Datum zum Spieldatum passt
// Video muss am Spieltag oder bis zu 2 Tage danach veröffentlicht worden sein
function isVideoDateValid(video, matchDate) {
    // API liefert verschiedene Datumsfelder: date, validFrom, publishedDate
    const videoDateStr = video.date || video.validFrom || video.publishedDate;
    
    if (!videoDateStr) {
        console.log(`    ⚠ Kein Datum im Video gefunden`);
        return false;
    }
    
    const videoDate = new Date(videoDateStr);
    const matchDateObj = new Date(matchDate);
    
    // Nur das Datum vergleichen, nicht die Uhrzeit
    videoDate.setHours(0, 0, 0, 0);
    matchDateObj.setHours(0, 0, 0, 0);
    
    // Video muss am Spieltag oder bis zu 2 Tage danach sein
    const diffDays = (videoDate - matchDateObj) / (1000 * 60 * 60 * 24);
    
    if (diffDays >= 0 && diffDays <= 2) {
        return true;
    }
    
    return false;
}

// Prüfe ob das Video lang genug ist (mindestens 90 Sekunden)
// Filtert Tor-Clips und kurze Interviews aus
const MIN_DURATION_MS = 90 * 1000; // 90 Sekunden in Millisekunden

function isVideoLongEnough(video) {
    const duration = video.duration || 0;
    return duration >= MIN_DURATION_MS;
}

// Blacklist: Videos mit diesen Wörtern im Titel sind keine Spielberichte
const TITLE_BLACKLIST = ['trainer', 'coach', 'interview', 'pressekonferenz', 'vorstellung', 'bilanz', 'analyse', 'vorschau', 'reaktion', 'stimmen'];

function isNotBlacklisted(video) {
    const title = (video.title || '').toLowerCase();
    for (const word of TITLE_BLACKLIST) {
        if (title.includes(word)) {
            return false;
        }
    }
    return true;
}

// Hole ALLE Keywords für ein Team
function getAllKeywords(teamName, teamsData) {
    const teamInfo = teamsData.teams[teamName];
    if (teamInfo && teamInfo.keywords && teamInfo.keywords.length > 0) {
        return teamInfo.keywords;
    }
    return [teamName];
}

// Hole Derby-Keywords falls vorhanden
function getDerbyKeywords(homeTeam, awayTeam, teamsData) {
    if (!teamsData.match_combinations) return [];
    
    // Prüfe beide Richtungen
    const key1 = `${homeTeam} vs ${awayTeam}`;
    const key2 = `${awayTeam} vs ${homeTeam}`;
    
    const combo = teamsData.match_combinations[key1] || teamsData.match_combinations[key2];
    if (combo && combo.keywords) {
        return combo.keywords;
    }
    return [];
}

// Finde Spiele die gesucht werden müssen
function getMatchesToSearch(spielplan, links, testMatchday = null) {
    const now = new Date();
    const matchesToSearch = [];
    const MAX_SEARCH_HOURS = 6; // Maximal 6 Stunden nach searchStart suchen
    
    for (const matchday of spielplan.matchdays) {
        if (testMatchday !== null && matchday.matchday !== testMatchday) {
            continue;
        }
        
        for (const match of matchday.matches) {
            // Match-Key enthält jetzt den Spieltag, um Hin- und Rückrunde zu unterscheiden
            const matchKey = `${matchday.matchday}_${match.home} - ${match.away}`;
            
            // Überspringe wenn Link bereits gefunden
            if (links.matches[matchKey] && links.matches[matchKey].url) {
                continue;
            }
            
            // Im Test-Modus: Ignoriere searchStart
            if (testMatchday !== null) {
                matchesToSearch.push({
                    matchday: matchday.matchday,
                    ...match,
                    matchKey
                });
                continue;
            }
            
            // Prüfe ob Suchzeit erreicht ist UND nicht zu alt
            if (match.searchStart) {
                const searchTime = new Date(match.searchStart);
                const searchEndTime = new Date(searchTime.getTime() + MAX_SEARCH_HOURS * 60 * 60 * 1000);
                
                if (now >= searchTime && now <= searchEndTime) {
                    matchesToSearch.push({
                        matchday: matchday.matchday,
                        ...match,
                        matchKey
                    });
                } else if (now > searchEndTime) {
                    console.log(`  ⏰ Timeout: ${matchKey} (Suche beendet nach ${MAX_SEARCH_HOURS}h)`);
                }
            }
        }
    }
    
    return matchesToSearch;
}

// Baue die SRF Video-URL
function buildVideoUrl(urn) {
    return `https://www.srf.ch/play/tv/-/video/-?urn=${urn}`;
}

// Hauptfunktion
async function crawl() {
    console.log('=== SRF Super League Crawler ===');
    console.log(`Zeit: ${new Date().toISOString()}`);
    
    // Lade Daten
    const teams = loadJSON(TEAMS_FILE);
    const spielplan = loadJSON(SPIELPLAN_FILE);
    let links = loadJSON(LINKS_FILE);
    
    if (!teams || !spielplan) {
        console.error('Konnte teams.json oder spielplan.json nicht laden');
        process.exit(1);
    }
    
    // Initialisiere links.json falls nicht vorhanden
    if (!links) {
        links = { lastUpdated: new Date().toISOString(), matches: {} };
    }
    
    // Prüfe auf --test Flag mit optionalem Spieltag
    let testMatchday = null;
    const testIndex = process.argv.indexOf('--test');
    if (testIndex !== -1) {
        const nextArg = process.argv[testIndex + 1];
        if (nextArg && !nextArg.startsWith('-')) {
            testMatchday = parseInt(nextArg, 10);
        } else {
            testMatchday = 22;
        }
        console.log(`TEST-MODUS: Suche Spieltag ${testMatchday}`);
    }
    
    // Finde Spiele zum Suchen
    const matchesToSearch = getMatchesToSearch(spielplan, links, testMatchday);
    
    if (matchesToSearch.length === 0) {
        console.log('Keine Spiele zum Suchen.');
        return;
    }
    
    console.log(`\nSuche nach ${matchesToSearch.length} Spielen:`);
    matchesToSearch.forEach(m => console.log(`  - ${m.matchKey}`));
    
    let foundCount = 0;
    
    for (const match of matchesToSearch) {
        console.log(`\n--- ${match.matchKey} ---`);
        
        // Sammle Keywords
        const homeKeywords = getAllKeywords(match.home, teams);
        const awayKeywords = getAllKeywords(match.away, teams);
        const derbyKeywords = getDerbyKeywords(match.home, match.away, teams);
        
        // Erstelle Kombinationen: "Home Away" Paare zuerst (spezifischer), dann einzelne Keywords
        const combinedSearches = [];
        
        // Kombinationen aus erstem Keyword jedes Teams
        combinedSearches.push(`${homeKeywords[0]} ${awayKeywords[0]}`);
        
        // Derby-Keywords
        for (const dk of derbyKeywords) {
            combinedSearches.push(dk);
        }
        
        // Dann einzelne Keywords als Fallback
        const allKeywords = [...new Set([...homeKeywords, ...awayKeywords])];
        for (const kw of allKeywords) {
            if (!combinedSearches.includes(kw)) {
                combinedSearches.push(kw);
            }
        }
        
        console.log(`  Suchen: ${combinedSearches.join(', ')}`);
        
        let foundVideo = null;
        let videoType = null;
        
        // Probiere jede Suche, bis ein Video gefunden wird
        for (const keyword of combinedSearches) {
            if (foundVideo) break;
            
            const results = await searchVideos(keyword);
            console.log(`  Gefunden: ${results.length} Videos`);
            
            let standaloneMatch = null;
            let sendungMatch = null;
            
            for (const video of results) {
                const title = video.title || '';
                const description = video.description || '';
                const showTitle = video.show?.title || '';
                const fullText = `${title} ${description} ${showTitle}`;
                
                // Prüfe ob mindestens ein Team erwähnt wird
                const homeFound = findTeamInText(fullText, match.home, teams);
                const awayFound = findTeamInText(fullText, match.away, teams);
                
                // Prüfe ob das Datum passt
                const dateValid = isVideoDateValid(video, match.date);
                
                // Prüfe Mindestlänge (90 Sekunden)
                const longEnough = isVideoLongEnough(video);
                
                if ((homeFound || awayFound) && dateValid && longEnough) {
                    // Sport-Clip = Standalone Highlight (bevorzugt)
                    if (showTitle === 'Sport-Clip' && !standaloneMatch) {
                        standaloneMatch = video;
                    }
                    // Super League – Highlights = Sendung (Fallback)
                    else if (showTitle.includes('Super League') && !sendungMatch) {
                        sendungMatch = video;
                    }
                }
                
                if (standaloneMatch) break;
            }
            
            if (standaloneMatch) {
                foundVideo = standaloneMatch;
                videoType = 'Standalone';
            } else if (sendungMatch && !foundVideo) {
                foundVideo = sendungMatch;
                videoType = 'Sendung';
            }
            
            // Kurze Pause zwischen API-Calls
            await new Promise(r => setTimeout(r, 200));
        }
        
        if (foundVideo) {
            const videoUrl = buildVideoUrl(foundVideo.urn);
            
            console.log(`  ✓ GEFUNDEN (${videoType}): ${foundVideo.title}`);
            console.log(`    URL: ${videoUrl}`);
            
            links.matches[match.matchKey] = {
                url: videoUrl,
                foundAt: new Date().toISOString(),
                title: foundVideo.title,
                urn: foundVideo.urn,
                type: videoType
            };
            foundCount++;
        } else {
            console.log(`  ✗ Nicht gefunden`);
        }
    }
    
    // Speichere Ergebnisse
    if (foundCount > 0) {
        links.lastUpdated = new Date().toISOString();
        saveJSON(LINKS_FILE, links);
        console.log(`\n${foundCount} neue Links gespeichert in links.json`);
    } else {
        console.log('\nKeine neuen Links gefunden');
    }
}

// Starte Crawler
crawl().catch(error => {
    console.error('Crawler-Fehler:', error);
    process.exit(1);
});
